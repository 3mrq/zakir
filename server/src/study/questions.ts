// Question sets: generate → verify against sources → bank. Only verified ("active") questions are ever shown in quizzes.

import type { GenerateRequest, PageRef, QuestionAnswer, QuestionDTO, QuestionSetDTO, QuestionStatus, QuestionType, SetStatus } from '@zakir/shared';
import { QUESTION_TYPES } from '@zakir/shared';
import type { JobQueue } from '../ai/queue.ts';
import { toPageRef } from '../ai/task.ts';
import {
  makeGenerateTask,
  makeVerifyTask,
  MAX_COUNT,
  MAX_GENERATE_CHARS,
  type GenerateInput,
  type GenerateOutput,
  type VerifyInput,
  type VerifyOutput,
} from '../ai/tasks/questions.ts';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import type { ChapterService } from './chapters.ts';
import type { StyleService } from './style.ts';

/** Stored in questions.data_json. */
export interface QuestionData {
  options?: string[];
  correctIndex?: number;
  optionExplanations?: string[];
  correct?: boolean;
  modelAnswer?: string;
  keyPoints?: { text: string; refs: PageRef[] }[];
}

export interface QuestionRow {
  id: number;
  subject_id: number;
  set_id: number | null;
  chapter_id: number | null;
  qtype: QuestionType;
  difficulty: QuestionDTO['difficulty'];
  stem: string;
  data_json: string;
  explanation: string;
  refs_json: string;
  status: QuestionStatus;
  status_note: string | null;
  created_at: string;
}

export function questionToDTO(r: QuestionRow, withAnswer: boolean): QuestionDTO {
  const data = JSON.parse(r.data_json) as QuestionData;
  const dto: QuestionDTO = {
    id: r.id,
    subjectId: r.subject_id,
    setId: r.set_id,
    chapterId: r.chapter_id,
    type: r.qtype,
    difficulty: r.difficulty,
    stem: r.stem,
    options: data.options ?? null,
    refs: JSON.parse(r.refs_json),
    status: r.status,
    statusNote: r.status_note,
    createdAt: r.created_at,
  };
  if (withAnswer) {
    const answer: QuestionAnswer = {
      explanation: r.explanation,
      correctIndex: data.correctIndex,
      correct: data.correct,
      modelAnswer: data.modelAnswer,
      keyPoints: data.keyPoints,
      optionExplanations: data.optionExplanations,
    };
    dto.answer = answer;
  }
  return dto;
}

/** Plain-text rendering of a question with its answer, for the verifier. */
function renderForReview(r: QuestionRow): string {
  const d = JSON.parse(r.data_json) as QuestionData;
  const refs = (JSON.parse(r.refs_json) as PageRef[]).map((x) => `F${x.fileId}:p${x.page}`).join(', ');
  const lines = [`النوع: ${r.qtype}`, `السؤال: ${r.stem}`];
  if (d.options) d.options.forEach((o, i) => lines.push(`  ${String.fromCharCode(65 + i)}) ${o}${i === d.correctIndex ? '   ← الإجابة المعتبرة' : ''}`));
  if (d.correct !== undefined) lines.push(`الإجابة المعتبرة: ${d.correct ? 'صح' : 'خطأ'}`);
  if (d.modelAnswer) lines.push(`الإجابة النموذجية: ${d.modelAnswer}`);
  if (d.keyPoints) lines.push('نقاط التصحيح:', ...d.keyPoints.map((k) => `  - ${k.text}`));
  lines.push(`الشرح: ${r.explanation}`);
  if (d.optionExplanations) lines.push('شرح الخيارات:', ...d.optionExplanations.map((e, i) => `  ${String.fromCharCode(65 + i)}) ${e}`));
  lines.push(`المراجع: ${refs}`);
  return lines.join('\n');
}

export class QuestionService {
  private readonly generateTask;
  private readonly verifyTask;

  constructor(
    private readonly db: DB,
    private readonly queue: JobQueue,
    private readonly chapters: ChapterService,
    private readonly style: StyleService,
  ) {
    this.generateTask = makeGenerateTask({
      onSuccess: (out, input) => this.saveGenerated(out, input),
      onFailure: (input, msg) => this.setStatus(input.setId, 'failed', msg),
    });
    this.verifyTask = makeVerifyTask({
      onSuccess: (out, input) => this.saveVerdicts(out, input),
      onFailure: (input, msg) => this.setStatus(input.setId, 'failed', `فشل التحقق من الأسئلة، ولن تُعرض قبل التحقق: ${msg}`),
    });
  }

  // ---------- generation ----------

  generate(subjectId: number, req: GenerateRequest): QuestionSetDTO {
    if (!Number.isInteger(req.count) || req.count < 1 || req.count > MAX_COUNT) throw new UserError(`عدد الأسئلة من 1 إلى ${MAX_COUNT}.`);
    if (req.type !== 'mixed' && !QUESTION_TYPES.includes(req.type)) throw new UserError('نوع سؤال غير معروف.');
    if (!['easy', 'medium', 'hard', 'mixed'].includes(req.difficulty)) throw new UserError('مستوى صعوبة غير معروف.');
    const ids = [...new Set(req.chapterIds)];
    if (!ids.length) throw new UserError('اختر شابترًا واحدًا على الأقل.');
    const chapters = ids.map((id) => {
      const c = this.chapters.get(id);
      if (!c || c.subjectId !== subjectId) throw new UserError('بعض الشباترات المختارة ليست من هذه المادة.');
      return { id: c.id, title: c.title, pages: this.chapters.pages(c.id).filter((p) => p.text.trim()) };
    });
    const empty = chapters.filter((c) => !c.pages.length);
    if (empty.length) throw new UserError(`لا يوجد نص في: ${empty.map((c) => `«${c.title}»`).join('، ')}.`);
    const chars = chapters.reduce((n, c) => n + c.pages.reduce((m, p) => m + p.text.length, 0), 0);
    if (chars > MAX_GENERATE_CHARS) throw new UserError('الشباترات المختارة كبيرة جدًا لاستدعاء واحد. اختر شباترات أقل.');

    const style = this.style.latest(subjectId);
    const setId = Number(
      this.db
        .prepare(`INSERT INTO question_sets (subject_id, chapter_ids_json, qtype, difficulty, requested, style_id, status) VALUES (?, ?, ?, ?, ?, ?, 'generating')`)
        .run(subjectId, JSON.stringify(ids), req.type, req.difficulty, req.count, style?.id ?? null).lastInsertRowid,
    );
    const input: GenerateInput = { setId, type: req.type, difficulty: req.difficulty, count: req.count, chapters, style: style?.profile ?? null };
    this.queue.enqueue(this.generateTask, input, { type: 'question_set', id: setId });
    return this.getSet(setId)!;
  }

  private saveGenerated(out: GenerateOutput, input: GenerateInput) {
    const subjectId = (this.db.prepare(`SELECT subject_id FROM question_sets WHERE id = ?`).get(input.setId) as { subject_id: number } | undefined)?.subject_id;
    if (!subjectId) return; // set deleted meanwhile
    const ins = this.db.prepare(
      `INSERT INTO questions (subject_id, set_id, chapter_id, qtype, difficulty, stem, data_json, explanation, refs_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    this.db.transaction(() => {
      for (const q of out.questions) {
        const chapterId = input.chapters[Number(q.chapter.slice(1)) - 1]?.id ?? null;
        const data: QuestionData =
          q.type === 'mcq'
            ? { options: q.options, correctIndex: q.correctIndex, optionExplanations: q.optionExplanations }
            : q.type === 'true_false'
              ? { correct: q.correct }
              : { modelAnswer: q.modelAnswer, keyPoints: q.keyPoints!.map((k) => ({ text: k.text, refs: k.refs.map(toPageRef) })) };
        ins.run(subjectId, input.setId, chapterId, q.type, q.difficulty, q.stem.trim(), JSON.stringify(data), q.explanation, JSON.stringify(q.refs.map(toPageRef)));
      }
    })();
    this.startVerify(input.setId);
  }

  /** Sends a set's pending questions, with only the pages they cite, to an independent review. */
  startVerify(setId: number) {
    const rows = this.db.prepare(`SELECT * FROM questions WHERE set_id = ? AND status = 'pending' ORDER BY id`).all(setId) as QuestionRow[];
    if (!rows.length) return this.setStatus(setId, 'ready');
    const cited = new Map<string, PageRef>();
    for (const r of rows) {
      const refs = [...(JSON.parse(r.refs_json) as PageRef[]), ...((JSON.parse(r.data_json) as QuestionData).keyPoints ?? []).flatMap((k) => k.refs)];
      for (const x of refs) cited.set(`${x.fileId}:${x.page}`, x);
    }
    const get = this.db.prepare(`SELECT text FROM pages WHERE file_id = ? AND page_no = ?`);
    const pages = [...cited.values()].map((x) => ({ ...x, text: (get.get(x.fileId, x.page) as { text: string } | undefined)?.text ?? '' }));
    const input: VerifyInput = {
      setId,
      questions: rows.map((r) => ({ id: r.id, text: renderForReview(r), refs: JSON.parse(r.refs_json) })),
      pages,
    };
    this.setStatus(setId, 'verifying');
    this.queue.enqueue(this.verifyTask, input, { type: 'question_set', id: setId });
  }

  retryVerify(setId: number) {
    const set = this.getSet(setId);
    if (!set) throw new UserError('المجموعة غير موجودة.', 404);
    if (set.counts.pending === 0) throw new UserError('لا توجد أسئلة بانتظار التحقق في هذه المجموعة.');
    this.startVerify(setId);
  }

  private saveVerdicts(out: VerifyOutput, input: VerifyInput) {
    const upd = this.db.prepare(`UPDATE questions SET status = ?, status_note = ? WHERE id = ? AND status = 'pending'`);
    this.db.transaction(() => {
      for (const r of out.results) {
        const id = Number(r.question.slice(1));
        upd.run(r.verdict === 'ok' ? 'active' : 'rejected', r.verdict === 'ok' ? null : r.reason.trim(), id);
      }
    })();
    this.setStatus(input.setId, 'ready');
  }

  private setStatus(setId: number, status: SetStatus, error: string | null = null) {
    this.db.prepare(`UPDATE question_sets SET status = ?, error = ? WHERE id = ?`).run(status, error, setId);
  }

  // ---------- reads & reports ----------

  getSet(id: number): QuestionSetDTO | undefined {
    const r = this.db.prepare(`SELECT * FROM question_sets WHERE id = ?`).get(id) as
      | { id: number; subject_id: number; chapter_ids_json: string; qtype: string; difficulty: string; requested: number; style_id: number | null; status: SetStatus; error: string | null; created_at: string }
      | undefined;
    if (!r) return undefined;
    const counts = { active: 0, rejected: 0, reported: 0, pending: 0 };
    for (const c of this.db.prepare(`SELECT status, COUNT(*) n FROM questions WHERE set_id = ? GROUP BY status`).all(id) as { status: QuestionStatus; n: number }[]) {
      counts[c.status] = c.n;
    }
    return {
      id: r.id,
      subjectId: r.subject_id,
      chapterIds: JSON.parse(r.chapter_ids_json),
      type: r.qtype as QuestionSetDTO['type'],
      difficulty: r.difficulty as QuestionSetDTO['difficulty'],
      requested: r.requested,
      usedStyle: r.style_id !== null,
      status: r.status,
      error: r.error,
      counts,
      createdAt: r.created_at,
    };
  }

  listSets(subjectId: number): QuestionSetDTO[] {
    return (this.db.prepare(`SELECT id FROM question_sets WHERE subject_id = ? ORDER BY id DESC`).all(subjectId) as { id: number }[]).map((r) => this.getSet(r.id)!);
  }

  /** Bank view: everything except unverified questions, with answers. */
  list(subjectId: number, setId?: number): QuestionDTO[] {
    const rows = (
      setId
        ? this.db.prepare(`SELECT * FROM questions WHERE subject_id = ? AND set_id = ? AND status != 'pending' ORDER BY id`).all(subjectId, setId)
        : this.db.prepare(`SELECT * FROM questions WHERE subject_id = ? AND status != 'pending' ORDER BY id DESC`).all(subjectId)
    ) as QuestionRow[];
    return rows.map((r) => questionToDTO(r, true));
  }

  report(questionId: number, note: string) {
    const q = this.db.prepare(`SELECT id FROM questions WHERE id = ?`).get(questionId);
    if (!q) throw new UserError('السؤال غير موجود.', 404);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO question_reports (question_id, note) VALUES (?, ?)`).run(questionId, note);
      this.db.prepare(`UPDATE questions SET status = 'reported', status_note = ? WHERE id = ?`).run(note, questionId);
    })();
  }

  /** Puts a reported question back into use (the user decided the report was wrong). */
  restore(questionId: number) {
    const { changes } = this.db.prepare(`UPDATE questions SET status = 'active', status_note = NULL WHERE id = ? AND status = 'reported'`).run(questionId);
    if (!changes) throw new UserError('يمكن استعادة الأسئلة المبلّغ عنها فقط.');
  }
}
