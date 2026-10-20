// Quiz sessions: pick verified questions, grade instantly (choice questions locally, written answers by AI).

import type { AnswerInput, AttemptDTO, GradeFeedback, PageRef, QuizDTO, QuizRequest } from '@zakir/shared';
import { QUESTION_TYPES } from '@zakir/shared';
import type { JobQueue } from '../ai/queue.ts';
import { toPageRef } from '../ai/task.ts';
import { makeGradeTask, scoreFromKeyPoints, type GradeInput, type GradeOutput } from '../ai/tasks/grade.ts';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import { questionToDTO, type QuestionData, type QuestionRow } from './questions.ts';
import type { ReviewService } from './review.ts';

const DEFAULT_COUNT = 10;
const MAX_QUIZ = 50;

interface SessionRow {
  id: number;
  subject_id: number;
  kind: QuizDTO['kind'];
  title: string;
  time_limit_sec: number | null;
  started_at: string;
  finished_at: string | null;
}

interface AttemptRow {
  id: number;
  session_id: number;
  question_id: number;
  answer_json: string;
  status: AttemptDTO['status'];
  score: number | null;
  feedback_json: string | null;
  error: string | null;
}

export class QuizService {
  private readonly gradeTask;

  constructor(
    private readonly db: DB,
    private readonly queue: JobQueue,
    private readonly review?: ReviewService,
  ) {
    this.gradeTask = makeGradeTask({
      onSuccess: (out, input) => this.saveGrade(out, input),
      onFailure: (input, msg) => this.db.prepare(`UPDATE attempts SET status = 'failed', error = ? WHERE id = ?`).run(msg, input.attemptId),
    });
  }

  create(subjectId: number, req: QuizRequest): QuizDTO {
    const limit = Math.min(Math.max(1, Math.floor(req.count ?? DEFAULT_COUNT)), MAX_QUIZ);
    let rows: { id: number }[];
    let title: string;
    if (req.setId) {
      rows = this.db.prepare(`SELECT id FROM questions WHERE set_id = ? AND subject_id = ? AND status = 'active' ORDER BY id`).all(req.setId, subjectId) as { id: number }[];
      title = `اختبار مجموعة الأسئلة #${req.setId}`;
    } else {
      const where = [`q.subject_id = ?`, `q.status = 'active'`];
      const args: unknown[] = [subjectId];
      if (req.chapterIds?.length) {
        where.push(`q.chapter_id IN (${req.chapterIds.map(() => '?').join(',')})`);
        args.push(...req.chapterIds);
      }
      const types = (req.types ?? []).filter((t) => QUESTION_TYPES.includes(t));
      if (types.length) {
        where.push(`q.qtype IN (${types.map(() => '?').join(',')})`);
        args.push(...types);
      }
      // Least-practised questions first, random among equals.
      rows = this.db
        .prepare(
          `SELECT q.id FROM questions q LEFT JOIN attempts a ON a.question_id = q.id
           WHERE ${where.join(' AND ')} GROUP BY q.id ORDER BY COUNT(a.id), random() LIMIT ?`,
        )
        .all(...args, limit) as { id: number }[];
      title = 'اختبار تدريبي';
    }
    if (!rows.length) throw new UserError('لا توجد أسئلة مُتحقق منها تطابق اختيارك. ولّد أسئلة أولًا أو وسّع الاختيار.');

    return this.insertSession(subjectId, title, rows.map((r) => r.id), req.timeLimitMin ?? null, 'practice');
  }

  /** A review session from today's due cards; answers move the cards between Leitner boxes. */
  createReview(subjectId: number): QuizDTO {
    const ids = this.review?.dueQuestionIds(subjectId) ?? [];
    if (!ids.length) throw new UserError('لا توجد مراجعات مستحقة اليوم في هذه المادة.');
    return this.insertSession(subjectId, 'مراجعة اليوم', ids, null, 'review');
  }

  private insertSession(subjectId: number, title: string, questionIds: number[], minutes: number | null, kind: QuizDTO['kind']): QuizDTO {
    if (minutes !== null && (!Number.isFinite(minutes) || minutes < 1 || minutes > 300)) throw new UserError('مدة الاختبار من 1 إلى 300 دقيقة.');
    const id = this.db.transaction(() => {
      const sid = Number(
        this.db
          .prepare(`INSERT INTO quiz_sessions (subject_id, title, time_limit_sec, kind) VALUES (?, ?, ?, ?)`)
          .run(subjectId, title, minutes ? Math.round(minutes * 60) : null, kind)
          .lastInsertRowid,
      );
      const ins = this.db.prepare(`INSERT INTO quiz_items (session_id, question_id, ord) VALUES (?, ?, ?)`);
      questionIds.forEach((qid, i) => ins.run(sid, qid, i));
      return sid;
    })();
    return this.get(id)!;
  }

  private session(id: number): SessionRow | undefined {
    const s = this.db.prepare(`SELECT * FROM quiz_sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    // A timed quiz finishes by itself when its time is up.
    if (s && !s.finished_at && s.time_limit_sec) {
      const end = new Date(s.started_at).getTime() + s.time_limit_sec * 1000;
      if (Date.now() >= end) {
        const at = new Date(end).toISOString();
        this.db.prepare(`UPDATE quiz_sessions SET finished_at = ? WHERE id = ?`).run(at, id);
        s.finished_at = at;
      }
    }
    return s;
  }

  get(id: number): QuizDTO | undefined {
    const s = this.session(id);
    if (!s) return undefined;
    const qs = this.db
      .prepare(`SELECT q.* FROM quiz_items i JOIN questions q ON q.id = i.question_id WHERE i.session_id = ? ORDER BY i.ord`)
      .all(id) as QuestionRow[];
    const attempts = new Map(
      (this.db.prepare(`SELECT * FROM attempts WHERE session_id = ?`).all(id) as AttemptRow[]).map((a) => [a.question_id, a]),
    );
    const items = qs.map((q) => {
      const a = attempts.get(q.id);
      return { question: questionToDTO(q, !!a || !!s.finished_at), attempt: a ? this.attemptDTO(a) : null, card: a ? (this.review?.cardState(q.id) ?? null) : null };
    });
    const grading = items.some((i) => i.attempt?.status === 'grading');
    const score = s.finished_at && !grading ? items.reduce((n, i) => n + (i.attempt?.score ?? 0), 0) / items.length : null;
    return { id: s.id, subjectId: s.subject_id, kind: s.kind, title: s.title, timeLimitSec: s.time_limit_sec, startedAt: s.started_at, finishedAt: s.finished_at, items, score };
  }

  private attemptDTO(a: AttemptRow): AttemptDTO {
    return {
      answer: JSON.parse(a.answer_json),
      status: a.status,
      score: a.score,
      feedback: a.feedback_json ? JSON.parse(a.feedback_json) : null,
      error: a.error,
    };
  }

  answer(quizId: number, questionId: number, input: AnswerInput): QuizDTO {
    const s = this.session(quizId);
    if (!s) throw new UserError('الاختبار غير موجود.', 404);
    if (s.finished_at) throw new UserError(s.time_limit_sec ? 'انتهى وقت الاختبار.' : 'انتهى الاختبار.', 409);
    const q = this.db
      .prepare(`SELECT q.* FROM quiz_items i JOIN questions q ON q.id = i.question_id WHERE i.session_id = ? AND q.id = ?`)
      .get(quizId, questionId) as QuestionRow | undefined;
    if (!q) throw new UserError('السؤال ليس من هذا الاختبار.', 404);
    if (this.db.prepare(`SELECT 1 FROM attempts WHERE session_id = ? AND question_id = ?`).get(quizId, questionId)) {
      throw new UserError('أجبت عن هذا السؤال من قبل.', 409);
    }
    const data = JSON.parse(q.data_json) as QuestionData;
    const insert = (answer: AnswerInput, status: AttemptDTO['status'], score: number | null) =>
      Number(
        this.db
          .prepare(`INSERT INTO attempts (session_id, question_id, answer_json, status, score) VALUES (?, ?, ?, ?, ?)`)
          .run(quizId, questionId, JSON.stringify(answer), status, score).lastInsertRowid,
      );

    if (q.qtype === 'mcq') {
      const choice = input.choice;
      if (!Number.isInteger(choice) || choice! < 0 || choice! >= (data.options?.length ?? 0)) throw new UserError('اختر إجابة.');
      const score = choice === data.correctIndex ? 1 : 0;
      insert({ choice }, 'graded', score);
      this.review?.record(questionId, score, s.kind === 'review' ? 'review' : 'quiz');
    } else if (q.qtype === 'true_false') {
      if (typeof input.bool !== 'boolean') throw new UserError('اختر صح أو خطأ.');
      const score = input.bool === data.correct ? 1 : 0;
      insert({ bool: input.bool }, 'graded', score);
      this.review?.record(questionId, score, s.kind === 'review' ? 'review' : 'quiz');
    } else {
      const text = (input.text ?? '').trim();
      if (!text) throw new UserError('اكتب إجابتك.');
      if (text.length > 8000) throw new UserError('الإجابة أطول من 8000 حرف.');
      const attemptId = insert({ text }, 'grading', null);
      this.enqueueGrade(attemptId, q, data, text);
    }
    return this.get(quizId)!;
  }

  private enqueueGrade(attemptId: number, q: QuestionRow, data: QuestionData, text: string) {
    const refs = new Map<string, PageRef>();
    for (const r of [...(JSON.parse(q.refs_json) as PageRef[]), ...(data.keyPoints ?? []).flatMap((k) => k.refs)]) refs.set(`${r.fileId}:${r.page}`, r);
    const get = this.db.prepare(`SELECT text FROM pages WHERE file_id = ? AND page_no = ?`);
    const input: GradeInput = {
      attemptId,
      type: q.qtype as GradeInput['type'],
      stem: q.stem,
      modelAnswer: data.modelAnswer ?? '',
      keyPoints: (data.keyPoints ?? []).map((k) => k.text),
      answer: text,
      pages: [...refs.values()].map((r) => ({ ...r, text: (get.get(r.fileId, r.page) as { text: string } | undefined)?.text ?? '' })),
    };
    this.queue.enqueue(this.gradeTask, input, { type: 'attempt', id: attemptId });
  }

  /** Re-sends a written answer whose grading failed. */
  retryGrade(quizId: number, questionId: number): QuizDTO {
    const a = this.db.prepare(`SELECT * FROM attempts WHERE session_id = ? AND question_id = ?`).get(quizId, questionId) as AttemptRow | undefined;
    if (!a || a.status !== 'failed') throw new UserError('لا يوجد تصحيح فاشل لإعادته.');
    const q = this.db.prepare(`SELECT * FROM questions WHERE id = ?`).get(questionId) as QuestionRow;
    this.db.prepare(`UPDATE attempts SET status = 'grading', error = NULL WHERE id = ?`).run(a.id);
    this.enqueueGrade(a.id, q, JSON.parse(q.data_json), (JSON.parse(a.answer_json) as AnswerInput).text ?? '');
    return this.get(quizId)!;
  }

  private saveGrade(out: GradeOutput, input: GradeInput) {
    const ordered = [...out.keyPoints].sort((a, b) => a.index - b.index);
    const feedback: GradeFeedback = {
      summary: out.summary,
      keyPoints: ordered.map((k) => ({ status: k.status, note: k.note })),
      mistakes: out.mistakes.map((m) => ({ quote: m.quote, why: m.why, refs: m.refs.map(toPageRef) })),
    };
    this.db
      .prepare(`UPDATE attempts SET status = 'graded', score = ?, feedback_json = ?, error = NULL WHERE id = ?`)
      .run(scoreFromKeyPoints(ordered), JSON.stringify(feedback), input.attemptId);
    const a = this.db
      .prepare(`SELECT a.question_id, s.kind FROM attempts a JOIN quiz_sessions s ON s.id = a.session_id WHERE a.id = ?`)
      .get(input.attemptId) as { question_id: number; kind: QuizDTO['kind'] } | undefined;
    if (a) this.review?.record(a.question_id, scoreFromKeyPoints(ordered), a.kind === 'review' ? 'review' : 'quiz');
  }

  finish(quizId: number): QuizDTO {
    const s = this.session(quizId);
    if (!s) throw new UserError('الاختبار غير موجود.', 404);
    if (!s.finished_at) this.db.prepare(`UPDATE quiz_sessions SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(quizId);
    return this.get(quizId)!;
  }

  list(subjectId: number) {
    return (this.db.prepare(`SELECT id FROM quiz_sessions WHERE subject_id = ? ORDER BY id DESC LIMIT 30`).all(subjectId) as { id: number }[]).map((r) => {
      const q = this.get(r.id)!;
      return { id: q.id, title: q.title, startedAt: q.startedAt, finishedAt: q.finishedAt, total: q.items.length, answered: q.items.filter((i) => i.attempt).length, score: q.score };
    });
  }
}
