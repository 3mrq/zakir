// Uploaded files: storage, page-by-page extraction, AI reading of scanned pages, status.
// Every file is processed once; its pages live in the `pages` table from then on.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileDTO, FileKind, FileStatus, PageDTO } from '@zakir/shared';
import { JobQueue } from '../ai/queue.ts';
import { makeOcrTask, OCR_BATCH, type OcrInput, type OcrOutput } from '../ai/tasks/ocrPages.ts';
import type { DB } from '../db/index.ts';
import { toSearchText } from './normalize.ts';
import { cleanText, extractPdfPages } from './pdfText.ts';

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Bump when pdfText.ts changes in a way that improves existing files. 2 = diacritics attached to letters. */
export const EXTRACT_VERSION = 2;

const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/** Detects the type from the file's bytes (not its name). Returns undefined if unsupported. */
export function sniffMime(data: Uint8Array): string | undefined {
  const b = (i: number) => data[i];
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf'; // %PDF
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x52 && b(1) === 0x49 && b(8) === 0x57 && b(9) === 0x45) return 'image/webp'; // RIFF....WEBP
  return undefined;
}

export class UserError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

interface FileRow {
  id: number;
  subject_id: number;
  kind: FileKind;
  name: string;
  stored_path: string;
  mime: string;
  size: number;
  page_count: number | null;
  status: FileStatus;
  error: string | null;
  created_at: string;
}

export class FileService {
  private chain: Promise<void> = Promise.resolve();
  private readonly ocrTask;

  constructor(
    private readonly db: DB,
    private readonly queue: JobQueue,
    private readonly uploadsDir: string,
  ) {
    this.ocrTask = makeOcrTask({
      onSuccess: (out, input) => this.saveOcr(out, input),
      onFailure: (input, message) => this.failOcr(input, message),
    });
  }

  // ---------- queries ----------

  get(id: number): FileDTO | undefined {
    const row = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow | undefined;
    return row && this.toDTO(row);
  }

  listBySubject(subjectId: number): FileDTO[] {
    const rows = this.db.prepare(`SELECT * FROM files WHERE subject_id = ? ORDER BY id DESC`).all(subjectId) as FileRow[];
    return rows.map((r) => this.toDTO(r));
  }

  pages(fileId: number): PageDTO[] {
    return (
      this.db.prepare(`SELECT page_no, source, status, text, ai_note FROM pages WHERE file_id = ? ORDER BY page_no`).all(fileId) as {
        page_no: number;
        source: PageDTO['source'];
        status: PageDTO['status'];
        text: string;
        ai_note: string | null;
      }[]
    ).map((r) => ({ pageNo: r.page_no, source: r.source, status: r.status, text: r.text, aiNote: r.ai_note }));
  }

  absPath(id: number): { path: string; mime: string; name: string } | undefined {
    const r = this.db.prepare(`SELECT stored_path, mime, name FROM files WHERE id = ?`).get(id) as
      | { stored_path: string; mime: string; name: string }
      | undefined;
    return r && { path: join(this.uploadsDir, r.stored_path), mime: r.mime, name: r.name };
  }

  // ---------- commands ----------

  /** Stores an upload and schedules processing. The same content twice in one subject is not reprocessed. */
  add(args: { subjectId: number; kind: FileKind; name: string; data: Uint8Array }): { file: FileDTO; duplicate: boolean } {
    const { subjectId, kind, name, data } = args;
    if (data.byteLength === 0) throw new UserError(`الملف «${name}» فارغ.`);
    if (data.byteLength > MAX_FILE_BYTES) throw new UserError(`الملف «${name}» أكبر من ${MAX_FILE_BYTES / 1024 / 1024} ميجابايت.`, 413);
    const mime = sniffMime(data);
    if (!mime) {
      const hint = /\.(pptx?|key)$/i.test(name) ? ' حوّل السلايدات إلى PDF ثم ارفعها.' : /\.docx?$/i.test(name) ? ' احفظ الملف بصيغة PDF ثم ارفعه.' : '';
      throw new UserError(`نوع الملف «${name}» غير مدعوم. المدعوم: PDF وصور PNG وJPG وWEBP.${hint}`, 415);
    }
    const sha = createHash('sha256').update(data).digest('hex');
    const existing = this.db.prepare(`SELECT * FROM files WHERE subject_id = ? AND sha256 = ?`).get(subjectId, sha) as FileRow | undefined;
    if (existing) return { file: this.toDTO(existing), duplicate: true };

    const stored = `${subjectId}/${sha.slice(0, 32)}${MIME_EXT[mime]}`;
    mkdirSync(join(this.uploadsDir, String(subjectId)), { recursive: true });
    writeFileSync(join(this.uploadsDir, stored), data);
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO files (subject_id, kind, name, stored_path, mime, size, sha256, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`,
      )
      .run(subjectId, kind, name, stored, mime, data.byteLength, sha);
    const id = Number(lastInsertRowid);
    this.schedule(id);
    return { file: this.get(id)!, duplicate: false };
  }

  setKind(id: number, kind: FileKind) {
    this.db.prepare(`UPDATE files SET kind = ? WHERE id = ?`).run(kind, id);
  }

  /** Re-sends pages whose AI reading failed. */
  retryOcr(id: number): number {
    const file = this.get(id);
    if (!file) throw new UserError('الملف غير موجود.', 404);
    const pages = (this.db.prepare(`SELECT page_no FROM pages WHERE file_id = ? AND status = 'ocr_failed'`).all(id) as { page_no: number }[]).map(
      (r) => r.page_no,
    );
    if (!pages.length) return 0;
    this.db.prepare(`UPDATE pages SET status = 'pending_ocr', ai_note = NULL WHERE file_id = ? AND status = 'ocr_failed'`).run(id);
    this.enqueueOcr(id, pages);
    this.refreshStatus(id);
    return pages.length;
  }

  delete(id: number) {
    const f = this.absPath(id);
    if (!f) return;
    this.queue.cancelByRef('file', id);
    this.db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
    rmSync(f.path, { force: true });
  }

  deleteSubjectFiles(subjectId: number) {
    for (const r of this.db.prepare(`SELECT id FROM files WHERE subject_id = ?`).all(subjectId) as { id: number }[]) {
      this.queue.cancelByRef('file', r.id);
    }
    rmSync(join(this.uploadsDir, String(subjectId)), { recursive: true, force: true });
  }

  /**
   * After a restart: redo interrupted extractions, re-extract files made by an older extractor
   * (locally, keeping AI-read pages), and re-send pages still waiting for AI reading.
   */
  resume() {
    const redo = this.db
      .prepare(`SELECT id FROM files WHERE status = 'processing' OR (extract_version < ? AND status != 'failed')`)
      .all(EXTRACT_VERSION) as { id: number }[];
    for (const r of redo) this.schedule(r.id);
    const redoIds = new Set(redo.map((r) => r.id));
    const waiting = (
      this.db
        .prepare(`SELECT file_id, page_no FROM pages WHERE status = 'pending_ocr' AND file_id IN (SELECT id FROM files WHERE status = 'ocr') ORDER BY file_id, page_no`)
        .all() as { file_id: number; page_no: number }[]
    ).filter((w) => !redoIds.has(w.file_id)); // re-extraction enqueues its own pending pages
    const byFile = new Map<number, number[]>();
    for (const w of waiting) byFile.set(w.file_id, [...(byFile.get(w.file_id) ?? []), w.page_no]);
    for (const [fileId, pages] of byFile) this.enqueueOcr(fileId, pages);
  }

  /** Resolves when local extraction work is done (AI jobs may still be running). */
  whenExtracted(): Promise<void> {
    return this.chain;
  }

  // ---------- processing ----------

  /** Local extraction runs one file at a time, off the request path. */
  private schedule(id: number) {
    this.chain = this.chain.then(() => this.process(id)).catch((e) => console.error('extraction crashed', e));
  }

  private async process(id: number) {
    const f = this.absPath(id);
    if (!f) return; // deleted meanwhile
    // Pages already read by AI are kept on re-extraction — a file's pages are never re-sent.
    const aiPages = new Map(
      (
        this.db.prepare(`SELECT page_no, text, text_norm, ai_note FROM pages WHERE file_id = ? AND source = 'ai' AND status = 'ok'`).all(id) as {
          page_no: number;
          text: string;
          text_norm: string;
          ai_note: string | null;
        }[]
      ).map((p) => [p.page_no, p]),
    );
    this.db.prepare(`DELETE FROM pages WHERE file_id = ?`).run(id);
    try {
      let extracted: { page: number; text: string; ok: boolean }[];
      if (f.mime === 'application/pdf') {
        extracted = (await extractPdfPages(new Uint8Array(readFileSync(f.path)))).map((p) => ({ page: p.page, text: p.text, ok: p.quality === 'ok' }));
      } else {
        extracted = [{ page: 1, text: '', ok: false }];
      }
      const ins = this.db.prepare(`INSERT INTO pages (file_id, page_no, text, text_norm, source, status, ai_note) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const pending: number[] = [];
      this.db.transaction(() => {
        for (const p of extracted) {
          const ai = aiPages.get(p.page);
          if (p.ok) ins.run(id, p.page, p.text, toSearchText(p.text), 'direct', 'ok', null);
          else if (ai) ins.run(id, p.page, ai.text, ai.text_norm, 'ai', 'ok', ai.ai_note);
          else {
            ins.run(id, p.page, '', '', null, 'pending_ocr', null);
            pending.push(p.page);
          }
        }
        this.db.prepare(`UPDATE files SET page_count = ?, error = NULL, extract_version = ? WHERE id = ?`).run(extracted.length, EXTRACT_VERSION, id);
      })();
      if (pending.length) this.enqueueOcr(id, pending);
      this.refreshStatus(id);
    } catch (e) {
      const name = (e as { name?: string }).name;
      const msg =
        name === 'PasswordException'
          ? 'الملف محمي بكلمة مرور. احفظ نسخة بدون حماية ثم ارفعها.'
          : name === 'InvalidPDFException'
            ? 'تعذّر فتح الملف: قد يكون تالفًا.'
            : `تعذّر استخراج النص: ${(e as Error).message}`;
      this.db.prepare(`UPDATE files SET status = 'failed', error = ? WHERE id = ?`).run(msg, id);
    }
  }

  private enqueueOcr(fileId: number, pages: number[]) {
    const f = this.absPath(fileId);
    if (!f) return;
    for (let i = 0; i < pages.length; i += OCR_BATCH) {
      const input: OcrInput = { fileId, path: f.path, mime: f.mime, pages: pages.slice(i, i + OCR_BATCH) };
      this.queue.enqueue(this.ocrTask, input, { type: 'file', id: fileId });
    }
  }

  private saveOcr(out: OcrOutput, input: OcrInput) {
    const upd = this.db.prepare(
      `UPDATE pages SET text = ?, text_norm = ?, source = 'ai', status = ?, ai_note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE file_id = ? AND page_no = ?`,
    );
    this.db.transaction(() => {
      for (const p of out.pages) {
        // "unreadable" is a failure the user must see (and can retry) — never an empty "ok" page.
        if (p.result === 'unreadable') {
          upd.run('', '', 'ocr_failed', `تعذّرت القراءة: ${p.note ?? 'سبب غير معروف'}`, input.fileId, p.page);
          continue;
        }
        const text = p.result === 'read' ? cleanText(p.text) : '';
        const note = p.result === 'blank' ? (p.note ?? 'صفحة بلا نص') : (p.note ?? null);
        upd.run(text, toSearchText(text), 'ok', note, input.fileId, p.page);
      }
    })();
    this.refreshStatus(input.fileId);
  }

  private failOcr(input: OcrInput, message: string) {
    const upd = this.db.prepare(`UPDATE pages SET status = 'ocr_failed', ai_note = ? WHERE file_id = ? AND page_no = ? AND status = 'pending_ocr'`);
    this.db.transaction(() => input.pages.forEach((p) => upd.run(message, input.fileId, p)))();
    this.refreshStatus(input.fileId);
  }

  private refreshStatus(fileId: number) {
    const s = this.stats(fileId);
    const status: FileStatus = s.pending ? 'ocr' : s.failed ? 'partial' : 'ready';
    this.db.prepare(`UPDATE files SET status = ? WHERE id = ? AND status != 'failed'`).run(status, fileId);
  }

  private stats(fileId: number) {
    return this.db
      .prepare(
        `SELECT COUNT(*) total,
           COALESCE(SUM(status = 'ok' AND source = 'direct'), 0) direct,
           COALESCE(SUM(status = 'ok' AND source = 'ai'), 0) ai,
           COALESCE(SUM(status = 'pending_ocr'), 0) pending,
           COALESCE(SUM(status = 'ocr_failed'), 0) failed
         FROM pages WHERE file_id = ?`,
      )
      .get(fileId) as FileDTO['pages'];
  }

  private toDTO(r: FileRow): FileDTO {
    return {
      id: r.id,
      subjectId: r.subject_id,
      kind: r.kind,
      name: r.name,
      mime: r.mime,
      size: r.size,
      pageCount: r.page_count,
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      pages: this.stats(r.id),
    };
  }
}
