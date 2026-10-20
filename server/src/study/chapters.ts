// Chapters: page ranges over a subject's content files, topics inside them, summaries, exam scope.

import { createHash } from 'node:crypto';
import type { ChapterDTO, ChapterInput, JobDTO, RangeDTO, SummaryDTO, SummaryPoint, TopicDTO } from '@zakir/shared';
import type { JobQueue } from '../ai/queue.ts';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import { makeSegmentTask, type SegmentInput } from '../ai/tasks/segment.ts';
import { makeSummarizeTask, MAX_SUMMARY_CHARS, type SummarizeInput, type SummarizeOutput } from '../ai/tasks/summarize.ts';

export interface ContentFile {
  id: number;
  name: string;
  pageCount: number;
}

/**
 * Checks a full chapter list against the subject's content files. Returns Arabic problems, empty if valid.
 * Used both for manual edits and for the AI's segmentation output.
 */
/** Wraps user text in Unicode bidi isolates so mixed Arabic/English names display correctly inside Arabic messages. */
const iso = (s: string) => `⁨${s}⁩`;

export function validateChapters(inputs: ChapterInput[], files: ContentFile[]): string[] {
  const problems: string[] = [];
  const byId = new Map(files.map((f) => [f.id, f]));
  const taken = new Map<number, { from: number; to: number; title: string }[]>();
  const fileLabel = (id: number) => (byId.get(id) ? `«${iso(byId.get(id)!.name)}»` : `F${id}`);

  const checkRange = (r: RangeDTO, where: string) => {
    const f = byId.get(r.fileId);
    if (!f) return problems.push(`${where}: الملف F${r.fileId} ليس من ملفات المحتوى في هذه المادة`), false;
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 1 || r.to < r.from) {
      return problems.push(`${where}: نطاق صفحات غير صالح (${r.from}–${r.to})`), false;
    }
    if (r.to > f.pageCount) return problems.push(`${where}: الملف ${fileLabel(r.fileId)} فيه ${f.pageCount} صفحة فقط (طُلب حتى ${r.to})`), false;
    return true;
  };

  inputs.forEach((ch, i) => {
    const name = ch.title.trim() ? `الشابتر «${iso(ch.title.trim())}»` : `الشابتر رقم ${i + 1}`;
    if (!ch.title.trim()) problems.push(`${name}: العنوان مطلوب`);
    if (!ch.ranges.length) problems.push(`${name}: يحتاج نطاق صفحات واحدًا على الأقل`);
    for (const r of ch.ranges) {
      if (!checkRange(r, name)) continue;
      const list = taken.get(r.fileId) ?? [];
      const clash = list.find((o) => r.from <= o.to && o.from <= r.to);
      if (clash) problems.push(`${name}: الصفحات ${r.from}–${r.to} من ${fileLabel(r.fileId)} متداخلة مع «${iso(clash.title)}»`);
      list.push({ from: r.from, to: r.to, title: ch.title.trim() });
      taken.set(r.fileId, list);
    }
    for (const t of ch.topics) {
      const tname = `${name}، الموضوع «${iso(t.title.trim() || '؟')}»`;
      if (!t.title.trim()) problems.push(`${tname}: العنوان مطلوب`);
      if (!checkRange(t, tname)) continue;
      const inside = ch.ranges.some((r) => r.fileId === t.fileId && r.from <= t.from && t.to <= r.to);
      if (!inside) problems.push(`${tname}: صفحاته ${t.from}–${t.to} خارج نطاق الشابتر`);
    }
  });
  return problems;
}

const naturalName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ar', { numeric: true });

export class ChapterService {
  private readonly segmentTask;
  private readonly summarizeTask;

  constructor(
    private readonly db: DB,
    private readonly queue: JobQueue,
  ) {
    this.segmentTask = makeSegmentTask({
      onSuccess: (chapters, input) => this.replaceAll(input.subjectId, chapters, true),
      check: (chapters, input) => validateChapters(chapters, input.files),
    });
    this.summarizeTask = makeSummarizeTask({ onSuccess: (out, input) => this.saveSummary(out, input) });
  }

  // ---------- reads ----------

  contentFiles(subjectId: number): (ContentFile & { status: string })[] {
    return (
      this.db
        .prepare(`SELECT id, name, COALESCE(page_count, 0) pageCount, status FROM files WHERE subject_id = ? AND kind = 'content'`)
        .all(subjectId) as (ContentFile & { status: string })[]
    ).sort(naturalName);
  }

  list(subjectId: number): ChapterDTO[] {
    const ids = this.db.prepare(`SELECT id FROM chapters WHERE subject_id = ? ORDER BY ord, id`).all(subjectId) as { id: number }[];
    return ids.map((r) => this.get(r.id)!);
  }

  get(id: number): ChapterDTO | undefined {
    const c = this.db.prepare(`SELECT * FROM chapters WHERE id = ?`).get(id) as
      | { id: number; subject_id: number; title: string; ord: number; auto_generated: number }
      | undefined;
    if (!c) return undefined;
    const ranges = this.db
      .prepare(`SELECT file_id fileId, page_from "from", page_to "to" FROM chapter_ranges WHERE chapter_id = ? ORDER BY ord`)
      .all(id) as RangeDTO[];
    const topics = this.db
      .prepare(`SELECT title, file_id fileId, page_from "from", page_to "to" FROM topics WHERE chapter_id = ? ORDER BY ord`)
      .all(id) as TopicDTO[];
    const s = this.db.prepare(`SELECT source_hash FROM summaries WHERE chapter_id = ?`).get(id) as { source_hash: string } | undefined;
    return {
      id: c.id,
      subjectId: c.subject_id,
      title: c.title,
      ord: c.ord,
      autoGenerated: !!c.auto_generated,
      ranges,
      topics,
      pageCount: ranges.reduce((n, r) => n + r.to - r.from + 1, 0),
      summary: !s ? 'none' : s.source_hash === this.sourceHash(id) ? 'ready' : 'stale',
    };
  }

  /** The chapter's pages in reading order, with their stored text. */
  pages(chapterId: number): { fileId: number; page: number; text: string }[] {
    return this.db
      .prepare(
        `SELECT p.file_id fileId, p.page_no page, p.text FROM chapter_ranges r
         JOIN pages p ON p.file_id = r.file_id AND p.page_no BETWEEN r.page_from AND r.page_to
         WHERE r.chapter_id = ? ORDER BY r.ord, p.page_no`,
      )
      .all(chapterId) as { fileId: number; page: number; text: string }[];
  }

  sourceHash(chapterId: number): string {
    const h = createHash('sha256');
    for (const p of this.pages(chapterId)) h.update(`${p.fileId}:${p.page}:${p.text}\n`);
    return h.digest('hex');
  }

  summary(chapterId: number): SummaryDTO | undefined {
    const r = this.db.prepare(`SELECT * FROM summaries WHERE chapter_id = ?`).get(chapterId) as
      | { chapter_id: number; quick_json: string; detailed_json: string; source_hash: string; model: string | null; created_at: string }
      | undefined;
    if (!r) return undefined;
    return {
      chapterId,
      quick: JSON.parse(r.quick_json),
      detailed: JSON.parse(r.detailed_json),
      stale: r.source_hash !== this.sourceHash(chapterId),
      model: r.model,
      createdAt: r.created_at,
    };
  }

  // ---------- writes ----------

  /**
   * Saves the full chapter list of a subject. Inputs with an id update that chapter (keeping its
   * summary, which then shows as outdated if its pages changed); chapters left out are deleted.
   */
  replaceAll(subjectId: number, inputs: ChapterInput[], auto = false) {
    const problems = validateChapters(inputs, this.contentFiles(subjectId));
    if (problems.length) throw new UserError(problems.slice(0, 5).join('\n'));

    const existing = new Set((this.db.prepare(`SELECT id FROM chapters WHERE subject_id = ?`).all(subjectId) as { id: number }[]).map((r) => r.id));
    this.db.transaction(() => {
      const keep = new Set<number>();
      inputs.forEach((ch, i) => {
        let id: number;
        if (!auto && ch.id && existing.has(ch.id)) {
          id = ch.id;
          this.db.prepare(`UPDATE chapters SET title = ?, ord = ? WHERE id = ?`).run(ch.title.trim(), i, id);
          this.db.prepare(`DELETE FROM chapter_ranges WHERE chapter_id = ?`).run(id);
          this.db.prepare(`DELETE FROM topics WHERE chapter_id = ?`).run(id);
        } else {
          id = Number(
            this.db.prepare(`INSERT INTO chapters (subject_id, title, ord, auto_generated) VALUES (?, ?, ?, ?)`).run(subjectId, ch.title.trim(), i, auto ? 1 : 0)
              .lastInsertRowid,
          );
        }
        keep.add(id);
        const ir = this.db.prepare(`INSERT INTO chapter_ranges (chapter_id, file_id, page_from, page_to, ord) VALUES (?, ?, ?, ?, ?)`);
        ch.ranges.forEach((r, j) => ir.run(id, r.fileId, r.from, r.to, j));
        const it = this.db.prepare(`INSERT INTO topics (chapter_id, title, file_id, page_from, page_to, ord) VALUES (?, ?, ?, ?, ?, ?)`);
        ch.topics.forEach((t, j) => it.run(id, t.title.trim(), t.fileId, t.from, t.to, j));
      });
      for (const id of existing) if (!keep.has(id)) this.db.prepare(`DELETE FROM chapters WHERE id = ?`).run(id);
    })();
  }

  setExamScope(examId: number, chapterIds: number[]) {
    const exam = this.db.prepare(`SELECT subject_id FROM exams WHERE id = ?`).get(examId) as { subject_id: number } | undefined;
    if (!exam) throw new UserError('الاختبار غير موجود.', 404);
    const valid = new Set(this.list(exam.subject_id).map((c) => c.id));
    const bad = chapterIds.filter((id) => !valid.has(id));
    if (bad.length) throw new UserError('بعض الشباترات المختارة ليست من هذه المادة.');
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM exam_scope WHERE exam_id = ?`).run(examId);
      const ins = this.db.prepare(`INSERT INTO exam_scope (exam_id, chapter_id) VALUES (?, ?)`);
      for (const id of new Set(chapterIds)) ins.run(examId, id);
    })();
  }

  // ---------- AI jobs ----------

  /** Auto-segments all content files of a subject. Replaces the existing chapters when it succeeds. */
  startSegmentation(subjectId: number): JobDTO {
    const ref = { type: 'subject', id: subjectId };
    const running = this.queue.activeFor('segment', ref);
    if (running) return running;
    const files = this.contentFiles(subjectId);
    if (!files.length) throw new UserError('ارفع ملفات محتوى أولًا (الاختبارات السابقة لا تدخل في الشباترات).');
    const busy = files.filter((f) => f.status === 'processing' || f.status === 'ocr');
    if (busy.length) throw new UserError(`انتظر حتى تنتهي معالجة: ${busy.map((f) => `«${f.name}»`).join('، ')}.`);

    const pageRows = this.db
      .prepare(`SELECT file_id, page_no, text FROM pages WHERE file_id IN (${files.map(() => '?').join(',')}) ORDER BY file_id, page_no`)
      .all(...files.map((f) => f.id)) as { file_id: number; page_no: number; text: string }[];
    const input: SegmentInput = {
      subjectId,
      files: files.map((f) => ({ id: f.id, name: f.name, pageCount: f.pageCount })),
      pages: pageRows.map((p) => ({ fileId: p.file_id, page: p.page_no, text: p.text })),
    };
    return this.queue.enqueue(this.segmentTask, input, ref);
  }

  startSummary(chapterId: number): JobDTO {
    const ref = { type: 'chapter', id: chapterId };
    const running = this.queue.activeFor('summarize', ref);
    if (running) return running;
    const ch = this.get(chapterId);
    if (!ch) throw new UserError('الشابتر غير موجود.', 404);
    const pages = this.pages(chapterId).filter((p) => p.text.trim());
    if (!pages.length) throw new UserError('لا يوجد نص في صفحات هذا الشابتر بعد.');
    const chars = pages.reduce((n, p) => n + p.text.length, 0);
    if (chars > MAX_SUMMARY_CHARS) {
      throw new UserError(`الشابتر كبير جدًا للتلخيص دفعة واحدة (${ch.pageCount} صفحة). قسّمه إلى شباترات أصغر من «تعديل الشباترات».`);
    }
    const topics = ch.topics.map((t) => t.title);
    const input: SummarizeInput = { chapterId, title: ch.title, topics, pages, sourceHash: this.sourceHash(chapterId) };
    return this.queue.enqueue(this.summarizeTask, input, ref);
  }

  private saveSummary(out: SummarizeOutput, input: SummarizeInput) {
    if (!this.get(input.chapterId)) return; // chapter deleted meanwhile
    const ref = (r: { file: string; page: number }) => ({ fileId: Number(r.file.slice(1)), page: r.page });
    const point = (p: { text: string; refs: { file: string; page: number }[] }): SummaryPoint => ({ text: p.text, refs: p.refs.map(ref) });
    const quick = out.quick.map(point);
    const detailed = out.detailed.map((s) => ({ heading: s.heading, points: s.points.map(point) }));
    this.db
      .prepare(
        `INSERT INTO summaries (chapter_id, quick_json, detailed_json, source_hash, model) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chapter_id) DO UPDATE SET quick_json = excluded.quick_json, detailed_json = excluded.detailed_json,
           source_hash = excluded.source_hash, model = excluded.model, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(input.chapterId, JSON.stringify(quick), JSON.stringify(detailed), input.sourceHash, null);
  }
}
