import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileDTO, PageDTO } from '@zakir/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIError } from '../ai/errors.ts';
import type { AIProvider, AIRequest, AIResponse } from '../ai/provider.ts';
import { buildApp } from '../app.ts';
import { extractPdfPages } from './pdfText.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');
const fixture = (n: string) => readFileSync(join(FIX, n));

/** Fake OCR: answers with the page numbers from the prompt's mapping table. */
class FakeOcr implements AIProvider {
  readonly id = 'fake';
  calls: AIRequest[] = [];
  fail = false;
  result: 'read' | 'blank' | 'unreadable' = 'read';
  workFiles: string[] = [];
  async healthCheck() {
    return { provider: 'fake', code: 'ok' as const, message: 'ok' };
  }
  async run(req: AIRequest): Promise<AIResponse> {
    this.calls.push(req);
    this.workFiles = readdirSync(req.workDir);
    if (this.fail) throw new AIError('USAGE_LIMIT');
    const pages = [...req.user.matchAll(/= الصفحة (\d+)/g)].map((m) => Number(m[1]));
    const text = (page: number) => (this.result === 'read' ? `نص مقروء للصفحة ${page} عن الإنزيمات (Enzymes)` : '');
    const note = this.result === 'unreadable' ? 'الصورة غير واضحة' : undefined;
    return { data: { pages: pages.map((page) => ({ page, result: this.result, text: text(page), note })) }, meta: {} };
  }
}

let dir: string;
let provider: FakeOcr;
let ctx: ReturnType<typeof buildApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zakir-ingest-'));
  provider = new FakeOcr();
  ctx = buildApp({ dataDir: dir, provider });
});
afterEach(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function upload(subjectId: number, kind: string, files: { name: string; data: Buffer }[]) {
  const form = new FormData();
  form.append('kind', kind);
  for (const f of files) form.append('file', new Blob([new Uint8Array(f.data)]), f.name);
  const req = new Request('http://x', { method: 'POST', body: form });
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/subjects/${subjectId}/files`,
    headers: { 'content-type': req.headers.get('content-type')! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
  return { status: res.statusCode, body: res.json() };
}

async function settle() {
  await ctx.files.whenExtracted();
  await ctx.queue.idle();
}

const getFile = async (id: number) => (await ctx.app.inject(`/api/files/${id}`)).json() as FileDTO;
const getPages = async (id: number) => (await ctx.app.inject(`/api/files/${id}/pages`)).json() as PageDTO[];

async function newSubject() {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/subjects', payload: { name: 'أحياء 101', doctor: 'د. سارة' } });
  expect(res.statusCode).toBe(201);
  return res.json().id as number;
}

describe('Arabic PDF extraction (fixture made by Edge from text.html)', () => {
  it('reconstructs Arabic lines in logical order with English terms intact', async () => {
    const pages = await extractPdfPages(new Uint8Array(fixture('text.pdf')));
    expect(pages.map((p) => p.quality)).toEqual(['ok', 'ok', 'ok']);
    expect(pages[0]!.text).toContain('الفصل الأول: الخلية');
    expect(pages[0]!.text).toContain('الخلية (Cell) هي الوحدة الأساسية للحياة.');
    expect(pages[0]!.text).toContain('(Prokaryotic cells) وخلايا حقيقية النواة (Eukaryotic cells).');
    expect(pages[1]!.text).toContain('وتنتج معظم طاقة الخلية على شكل ATP.');
    expect(pages[2]!.text).toContain('Ribosomes translate mRNA into a polypeptide chain.');
  });

  it('keeps diacritics (shadda, damma, tanween) on their letters', async () => {
    const pages = await extractPdfPages(new Uint8Array(fixture('course.pdf')));
    const all = pages.map((p) => p.text).join('\n');
    expect(all).toContain('يعدّل البروتينات ويغلّفها ويرسلها.');
    expect(all).toContain('التي تُخرج 3 أيونات صوديوم وتُدخل 2 أيون بوتاسيوم.');
    expect(all).toContain('كعوامل حفّازة (Catalysts)');
    expect(all).not.toMatch(/^\p{M}+$/mu); // no line made of marks only
    // Known limit: in this PDF the glyph for "رّ" maps to the shadda alone, so "تسرّع" loses its ر.
  });
});

describe('upload → extraction → AI reading', () => {
  it('extracts a text PDF directly with no AI call', async () => {
    const s = await newSubject();
    const up = await upload(s, 'content', [{ name: 'محاضرة 1.pdf', data: fixture('text.pdf') }]);
    expect(up.body.results[0]).toMatchObject({ ok: true, duplicate: false });
    await settle();
    const f = await getFile(up.body.results[0].fileId);
    expect(f).toMatchObject({ status: 'ready', pageCount: 3, kind: 'content', name: 'محاضرة 1.pdf' });
    expect(f.pages).toEqual({ total: 3, direct: 3, ai: 0, pending: 0, failed: 0 });
    expect(provider.calls).toHaveLength(0);
  });

  it('sends only the scanned page to AI and stores its text with source=ai', async () => {
    const s = await newSubject();
    const up = await upload(s, 'content', [{ name: 'mixed.pdf', data: fixture('mixed.pdf') }]);
    await settle();
    const id = up.body.results[0].fileId;
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.tools).toBe('read');
    expect(provider.calls[0]!.user).toContain('page-2.png = الصفحة 2');
    // Only the rendered scanned page is in the work dir — not the whole PDF.
    expect(provider.workFiles).toEqual(['page-2.png']);
    const pages = await getPages(id);
    expect(pages.map((p) => [p.pageNo, p.source, p.status])).toEqual([
      [1, 'direct', 'ok'],
      [2, 'ai', 'ok'],
    ]);
    expect((await getFile(id)).status).toBe('ready');
  });

  it('handles images, then search finds the AI-read text', async () => {
    const s = await newSubject();
    const up = await upload(s, 'past_exam', [{ name: 'note.png', data: fixture('scan.png') }]);
    await settle();
    const f = await getFile(up.body.results[0].fileId);
    expect(f).toMatchObject({ status: 'ready', kind: 'past_exam', mime: 'image/png', pageCount: 1 });
    const hit = ctx.db.prepare(`SELECT rowid FROM pages_fts WHERE pages_fts MATCH 'انزيمات'`).all();
    expect(hit).toHaveLength(1);
  });

  it('marks pages failed when AI reading fails, and retry re-sends only them', async () => {
    const s = await newSubject();
    provider.fail = true;
    const up = await upload(s, 'content', [{ name: 'mixed.pdf', data: fixture('mixed.pdf') }]);
    await settle();
    const id = up.body.results[0].fileId;
    let f = await getFile(id);
    expect(f.status).toBe('partial');
    expect(f.pages.failed).toBe(1);
    expect((await getPages(id))[1]!.aiNote).toContain('حد الاستخدام');

    provider.fail = false;
    const retry = await ctx.app.inject({ method: 'POST', url: `/api/files/${id}/retry-ocr` });
    expect(retry.json()).toEqual({ queued: 1 });
    await settle();
    f = await getFile(id);
    expect(f.status).toBe('ready');
    expect(f.pages).toMatchObject({ direct: 1, ai: 1, failed: 0 });
  });

  it('an "unreadable" answer is a visible failure, a "blank" page is ok with a note', async () => {
    const s = await newSubject();
    provider.result = 'unreadable';
    const a = await upload(s, 'content', [{ name: 'mixed.pdf', data: fixture('mixed.pdf') }]);
    await settle();
    const fa = await getFile(a.body.results[0].fileId);
    expect(fa.status).toBe('partial');
    expect((await getPages(fa.id))[1]).toMatchObject({ status: 'ocr_failed', aiNote: 'تعذّرت القراءة: الصورة غير واضحة' });

    provider.result = 'blank';
    const b = await upload(s, 'content', [{ name: 'note.png', data: fixture('scan.png') }]);
    await settle();
    const fb = await getFile(b.body.results[0].fileId);
    expect(fb.status).toBe('ready');
    expect((await getPages(fb.id))[0]).toMatchObject({ status: 'ok', text: '', aiNote: 'صفحة بلا نص' });
  });

  it('after a restart, pages still waiting for AI reading are sent again', async () => {
    const s = await newSubject();
    const up = await upload(s, 'content', [{ name: 'mixed.pdf', data: fixture('mixed.pdf') }]);
    await settle();
    const id = up.body.results[0].fileId;
    // Simulate a server stop while page 2 was waiting.
    ctx.db.prepare(`UPDATE pages SET status = 'pending_ocr', source = NULL, text = '' WHERE file_id = ? AND page_no = 2`).run(id);
    ctx.db.prepare(`UPDATE files SET status = 'ocr' WHERE id = ?`).run(id);
    await ctx.app.close();

    provider = new FakeOcr();
    ctx = buildApp({ dataDir: dir, provider });
    await settle();
    expect(provider.calls).toHaveLength(1);
    expect((await getFile(id)).status).toBe('ready');
    expect((await getPages(id))[1]).toMatchObject({ source: 'ai', status: 'ok' });
  });

  it('re-extracts files from an older extractor on startup, keeping AI-read pages without re-sending them', async () => {
    const s = await newSubject();
    const up = await upload(s, 'content', [{ name: 'mixed.pdf', data: fixture('mixed.pdf') }]);
    await settle();
    const id = up.body.results[0].fileId;
    expect(provider.calls).toHaveLength(1);
    ctx.db.prepare(`UPDATE files SET extract_version = 1 WHERE id = ?`).run(id);
    ctx.db.prepare(`UPDATE pages SET text = 'نص قديم مكسور' WHERE file_id = ? AND page_no = 1`).run(id);
    await ctx.app.close();

    provider = new FakeOcr();
    ctx = buildApp({ dataDir: dir, provider });
    await settle();
    expect(provider.calls).toHaveLength(0); // the AI page was kept
    const pages = await getPages(id);
    expect(pages[0]!.text).toContain('الفصل الأول: الخلية'); // re-extracted locally
    expect(pages[1]).toMatchObject({ source: 'ai', status: 'ok', text: 'نص مقروء للصفحة 2 عن الإنزيمات (Enzymes)' });
    expect(ctx.db.prepare(`SELECT extract_version v FROM files WHERE id = ?`).get(id)).toEqual({ v: 2 });
  });

  it('does not reprocess the same content twice and rejects unsupported types per file', async () => {
    const s = await newSubject();
    await upload(s, 'content', [{ name: 'a.pdf', data: fixture('text.pdf') }]);
    const up = await upload(s, 'content', [
      { name: 'نسخة.pdf', data: fixture('text.pdf') },
      { name: 'slides.pptx', data: Buffer.from('PK\x03\x04 not a pdf') },
    ]);
    expect(up.body.results[0]).toMatchObject({ ok: true, duplicate: true });
    expect(up.body.results[1].ok).toBe(false);
    expect(up.body.results[1].error).toContain('حوّل السلايدات إلى PDF');
    await settle();
    expect(ctx.db.prepare(`SELECT COUNT(*) n FROM files`).get()).toEqual({ n: 1 });
  });

  it('reports a corrupt PDF in Arabic', async () => {
    const s = await newSubject();
    const up = await upload(s, 'content', [{ name: 'bad.pdf', data: Buffer.from('%PDF-1.7 garbage garbage') }]);
    await settle();
    const f = await getFile(up.body.results[0].fileId);
    expect(f.status).toBe('failed');
    expect(f.error).toMatch(/تعذّر/);
  });

  it('deleting a subject removes its files, pages and search entries', async () => {
    const s = await newSubject();
    await upload(s, 'content', [{ name: 'a.pdf', data: fixture('text.pdf') }]);
    await settle();
    await ctx.app.inject({ method: 'DELETE', url: `/api/subjects/${s}` });
    expect(ctx.db.prepare(`SELECT (SELECT COUNT(*) FROM files) f, (SELECT COUNT(*) FROM pages) p`).get()).toEqual({ f: 0, p: 0 });
    expect(ctx.db.prepare(`SELECT COUNT(*) n FROM pages_fts WHERE pages_fts MATCH 'خليه'`).get()).toEqual({ n: 0 });
  });

  it('validates subjects and exams with Arabic messages', async () => {
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/subjects', payload: { name: '  ' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('اسم المادة مطلوب');
    const s = await newSubject();
    const ex = await ctx.app.inject({ method: 'POST', url: `/api/subjects/${s}/exams`, payload: { title: 'النهائي', examDate: '2026-12-20' } });
    expect(ex.json().exams).toEqual([{ id: 1, subjectId: s, title: 'النهائي', examDate: '2026-12-20', chapterIds: [] }]);
  });
});
