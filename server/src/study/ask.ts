// «اسأل المادة»: pick pages locally (chapter/topic scope, or FTS search), expand the query with AI only
// when search finds too little, then answer from those pages only. No pages → honest "not found",
// without spending a call.

import type { AskDTO, AskResult, AskScope, AskThreadDTO, Dialect, PageRef, Settings } from '@zakir/shared';
import type { JobQueue } from '../ai/queue.ts';
import { toPageRef } from '../ai/task.ts';
import { makeAskTask, makeExpandTask, MAX_ASK_CHARS, type AskInput, type AskOutput, type ExpandInput, type ExpandOutput } from '../ai/tasks/ask.ts';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import type { ChapterService } from './chapters.ts';
import { searchPages, searchTerms, termCoverage, type Hit } from './retrieval.ts';

const SEARCH_LIMIT = 12;
/**
 * Local search is "weak" — and the AI is asked for better keywords first — when it finds no page, or when
 * less than this share of the question's words exists anywhere in the files (e.g. an Arabic question about
 * English-only material). A precise question with a single matching page is not weak.
 */
const MIN_COVERAGE = 0.6;
const HISTORY = 3;

interface AskRow {
  id: number;
  thread_id: number;
  question: string;
  scope_json: string;
  dialect: Dialect;
  status: AskDTO['status'];
  retrieval: AskDTO['retrieval'];
  pages_json: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
}

const NOT_FOUND: AskResult = {
  found: 'no',
  segments: [],
  missing: 'لم أجد في ملفاتك صفحات تتعلق بهذا السؤال، لذلك لا أستطيع الإجابة عنه من المادة.',
};

/** Keeps pages in rank order until the character budget is used. */
function fitBudget<T extends { text: string }>(pages: T[], budget = MAX_ASK_CHARS): T[] {
  const out: T[] = [];
  let used = 0;
  for (const p of pages) {
    if (used + p.text.length > budget) break;
    out.push(p);
    used += p.text.length;
  }
  return out;
}

export class AskService {
  private readonly expandTask;
  private readonly askTask;

  constructor(
    private readonly db: DB,
    private readonly queue: JobQueue,
    private readonly chapters: ChapterService,
  ) {
    this.expandTask = makeExpandTask({
      onSuccess: (out, input) => this.afterExpand(out, input),
      onFailure: (input, msg) => this.fail(input.askId, msg),
    });
    this.askTask = makeAskTask({
      onSuccess: (out, input) => this.saveAnswer(out, input),
      onFailure: (input, msg) => this.fail(input.askId, msg),
    });
  }

  // ---------- settings ----------

  settings(): Settings {
    const r = this.db.prepare(`SELECT value FROM settings WHERE user_id = 1 AND key = 'dialect'`).get() as { value: string } | undefined;
    return { dialect: r?.value === 'saudi' ? 'saudi' : 'fusha' };
  }

  setSettings(s: Settings) {
    this.db.prepare(`INSERT INTO settings (user_id, key, value) VALUES (1, 'dialect', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(s.dialect);
  }

  // ---------- reads ----------

  private toDTO(r: AskRow): AskDTO {
    return {
      id: r.id,
      threadId: r.thread_id,
      question: r.question,
      scope: JSON.parse(r.scope_json),
      dialect: r.dialect,
      status: r.status,
      retrieval: r.retrieval,
      pages: r.pages_json ? JSON.parse(r.pages_json) : [],
      result: r.result_json ? JSON.parse(r.result_json) : null,
      error: r.error,
      createdAt: r.created_at,
    };
  }

  thread(id: number): AskThreadDTO | undefined {
    const t = this.db.prepare(`SELECT * FROM ask_threads WHERE id = ?`).get(id) as { id: number; subject_id: number; title: string; created_at: string } | undefined;
    if (!t) return undefined;
    const asks = (this.db.prepare(`SELECT * FROM asks WHERE thread_id = ? ORDER BY id`).all(id) as AskRow[]).map((r) => this.toDTO(r));
    return { id: t.id, subjectId: t.subject_id, title: t.title, createdAt: t.created_at, asks };
  }

  threads(subjectId: number): Omit<AskThreadDTO, 'asks'>[] {
    return (
      this.db.prepare(`SELECT id, subject_id, title, created_at FROM ask_threads WHERE subject_id = ? ORDER BY id DESC`).all(subjectId) as {
        id: number;
        subject_id: number;
        title: string;
        created_at: string;
      }[]
    ).map((t) => ({ id: t.id, subjectId: t.subject_id, title: t.title, createdAt: t.created_at }));
  }

  deleteThread(id: number) {
    for (const a of this.db.prepare(`SELECT id FROM asks WHERE thread_id = ?`).all(id) as { id: number }[]) this.queue.cancelByRef('ask', a.id);
    this.db.prepare(`DELETE FROM ask_threads WHERE id = ?`).run(id);
  }

  // ---------- asking ----------

  ask(subjectId: number, req: { threadId?: number; question: string; scope: AskScope }): AskThreadDTO {
    const question = req.question.trim();
    if (question.length < 2) throw new UserError('اكتب سؤالك.');
    if (question.length > 2000) throw new UserError('السؤال أطول من 2000 حرف.');
    const hasContent = this.db
      .prepare(`SELECT 1 FROM pages p JOIN files f ON f.id = p.file_id WHERE f.subject_id = ? AND f.kind = 'content' AND p.text != '' LIMIT 1`)
      .get(subjectId);
    if (!hasContent) throw new UserError('لا توجد ملفات محتوى مقروءة في هذه المادة بعد.');
    const scope = this.normalizeScope(subjectId, req.scope);

    let threadId = req.threadId;
    if (threadId) {
      const t = this.db.prepare(`SELECT subject_id FROM ask_threads WHERE id = ?`).get(threadId) as { subject_id: number } | undefined;
      if (!t || t.subject_id !== subjectId) throw new UserError('المحادثة غير موجودة.', 404);
    } else {
      const title = (scope.label ? `${scope.label}: ` : '') + question;
      threadId = Number(this.db.prepare(`INSERT INTO ask_threads (subject_id, title) VALUES (?, ?)`).run(subjectId, title.slice(0, 80)).lastInsertRowid);
    }
    const askId = Number(
      this.db
        .prepare(`INSERT INTO asks (thread_id, question, scope_json, dialect, status) VALUES (?, ?, ?, ?, 'searching')`)
        .run(threadId, question, JSON.stringify(scope), this.settings().dialect).lastInsertRowid,
    );
    this.retrieve(askId, subjectId);
    return this.thread(threadId)!;
  }

  retry(askId: number): AskThreadDTO {
    const r = this.row(askId);
    if (!r) throw new UserError('السؤال غير موجود.', 404);
    if (r.status !== 'failed') throw new UserError('يمكن إعادة الأسئلة التي فشلت فقط.');
    this.db.prepare(`UPDATE asks SET status = 'searching', error = NULL WHERE id = ?`).run(askId);
    this.retrieve(askId, this.subjectOf(askId));
    return this.thread(r.thread_id)!;
  }

  private row(id: number) {
    return this.db.prepare(`SELECT * FROM asks WHERE id = ?`).get(id) as AskRow | undefined;
  }

  private subjectOf(askId: number): number {
    return (this.db.prepare(`SELECT t.subject_id s FROM asks a JOIN ask_threads t ON t.id = a.thread_id WHERE a.id = ?`).get(askId) as { s: number }).s;
  }

  private normalizeScope(subjectId: number, scope: AskScope): AskScope {
    if (!scope.chapterId) return {};
    const ch = this.chapters.get(scope.chapterId);
    if (!ch || ch.subjectId !== subjectId) throw new UserError('الشابتر غير موجود في هذه المادة.');
    if (scope.range) {
      const inside = ch.ranges.some((r) => r.fileId === scope.range!.fileId && r.from <= scope.range!.from && scope.range!.to <= r.to && scope.range!.from <= scope.range!.to);
      if (!inside) throw new UserError('نطاق الصفحات خارج الشابتر.');
      return { chapterId: ch.id, range: scope.range, label: scope.label?.trim() || ch.title };
    }
    return { chapterId: ch.id, label: ch.title };
  }

  /** Chooses the pages for an ask, then answers — or expands the query first when search is weak. */
  private retrieve(askId: number, subjectId: number) {
    const r = this.row(askId)!;
    const scope = JSON.parse(r.scope_json) as AskScope;
    const terms = this.termsWithContext(r);

    if (scope.chapterId) {
      const ranges = scope.range ? [scope.range] : this.chapters.get(scope.chapterId)?.ranges ?? [];
      const all = this.chapters.pages(scope.chapterId).filter((p) => p.text.trim() && ranges.some((x) => x.fileId === p.fileId && x.from <= p.page && p.page <= x.to));
      const total = all.reduce((n, p) => n + p.text.length, 0);
      // Whole scope when it fits; otherwise the best-matching pages inside it.
      const pages = total <= MAX_ASK_CHARS ? all : fitBudget(searchPages(this.db, subjectId, terms, 30, ranges));
      return pages.length ? this.startAnswer(askId, pages, 'scope') : this.finishLocal(askId, NOT_FOUND, []);
    }

    const hits = fitBudget(searchPages(this.db, subjectId, terms, SEARCH_LIMIT));
    if (hits.length && termCoverage(this.db, subjectId, terms) >= MIN_COVERAGE) return this.startAnswer(askId, hits, 'search');
    const input: ExpandInput = { askId, question: r.question, outline: this.outline(subjectId) };
    this.queue.enqueue(this.expandTask, input, { type: 'ask', id: askId });
  }

  /**
   * Search terms of the question plus those of the previous question in the thread: follow-ups are short
   * and lean on context ("وعند أي pH يشتغل؟" after "ما هو الببسين؟").
   */
  private termsWithContext(r: AskRow): string[] {
    const prev = this.db.prepare(`SELECT question FROM asks WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT 1`).get(r.thread_id, r.id) as
      | { question: string }
      | undefined;
    return [...new Set([...searchTerms(r.question), ...(prev ? searchTerms(prev.question) : [])])];
  }

  private outline(subjectId: number): string {
    const chapters = this.chapters.list(subjectId);
    if (chapters.length) return chapters.map((c) => `- ${c.title}${c.topics.length ? `: ${c.topics.map((t) => t.title).join('، ')}` : ''}`).join('\n');
    return this.chapters.contentFiles(subjectId).map((f) => `- ${f.name}`).join('\n');
  }

  private afterExpand(out: ExpandOutput, input: ExpandInput) {
    if (!this.row(input.askId)) return;
    const subjectId = this.subjectOf(input.askId);
    const terms = [...new Set([...this.termsWithContext(this.row(input.askId)!), ...out.terms.flatMap((t) => searchTerms(t))])];
    const hits = fitBudget(searchPages(this.db, subjectId, terms, SEARCH_LIMIT));
    if (!hits.length) return this.finishLocal(input.askId, NOT_FOUND, []);
    this.startAnswer(input.askId, hits, 'search+expand');
  }

  private startAnswer(askId: number, pages: Hit[], retrieval: NonNullable<AskDTO['retrieval']>) {
    const r = this.row(askId)!;
    const refs: PageRef[] = pages.map((p) => ({ fileId: p.fileId, page: p.page }));
    this.db.prepare(`UPDATE asks SET status = 'answering', retrieval = ?, pages_json = ? WHERE id = ?`).run(retrieval, JSON.stringify(refs), askId);
    const history = (
      this.db.prepare(`SELECT question, result_json FROM asks WHERE thread_id = ? AND id < ? AND status = 'done' ORDER BY id DESC LIMIT ?`).all(r.thread_id, askId, HISTORY) as {
        question: string;
        result_json: string;
      }[]
    )
      .reverse()
      .map((h) => {
        const res = JSON.parse(h.result_json) as AskResult;
        return { question: h.question, answer: res.segments.map((s) => s.text).join(' ') || res.missing || '' };
      });
    const scope = JSON.parse(r.scope_json) as AskScope;
    const input: AskInput = {
      askId,
      question: r.question,
      dialect: r.dialect,
      scopeLabel: scope.label ? `«${scope.label}» فقط` : 'كل ملفات المادة (أكثر الصفحات صلة بالسؤال)',
      history,
      pages,
    };
    this.queue.enqueue(this.askTask, input, { type: 'ask', id: askId });
  }

  private saveAnswer(out: AskOutput, input: AskInput) {
    const result: AskResult = {
      found: out.found,
      segments: out.segments.map((s) => ({ text: s.text, refs: s.refs.map(toPageRef) })),
      missing: out.found === 'yes' ? null : out.missing.trim() || null,
    };
    this.db.prepare(`UPDATE asks SET status = 'done', result_json = ?, error = NULL WHERE id = ?`).run(JSON.stringify(result), input.askId);
  }

  private finishLocal(askId: number, result: AskResult, pages: PageRef[]) {
    this.db.prepare(`UPDATE asks SET status = 'done', result_json = ?, pages_json = ?, error = NULL WHERE id = ?`).run(JSON.stringify(result), JSON.stringify(pages), askId);
  }

  private fail(askId: number, message: string) {
    this.db.prepare(`UPDATE asks SET status = 'failed', error = ? WHERE id = ?`).run(message, askId);
  }
}
