// Reads scanned pages / images with Claude (Read tool only) and transcribes their text.
// PDF pages are rendered to PNG locally first; only those images are placed in the job's work dir.
// Up to OCR_BATCH pages per call to save quota.

import { copyFileSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { renderPdfPages } from '../../ingest/pdfText.ts';
import type { TaskDef } from '../task.ts';

export const OCR_BATCH = 4;

export interface OcrInput {
  fileId: number;
  /** Absolute path of the uploaded file. */
  path: string;
  mime: string;
  /** Original page numbers (1-based) to read. */
  pages: number[];
}

export const ocrOutput = z.object({
  pages: z.array(
    z.object({
      page: z.number().int().positive(),
      /** read = text transcribed; blank = page has no text; unreadable = could not read it. */
      result: z.enum(['read', 'blank', 'unreadable']),
      text: z.string(),
      note: z.string().optional(),
    }),
  ),
});
export type OcrOutput = z.infer<typeof ocrOutput>;

const isPdf = (mime: string) => mime === 'application/pdf';

/** Image file name in the work dir for each original page. */
function imageNames(input: OcrInput): string[] {
  return isPdf(input.mime) ? input.pages.map((p) => `page-${p}.png`) : [`page-1${extname(input.path).toLowerCase()}`];
}

export function makeOcrTask(hooks: {
  onSuccess(output: OcrOutput, input: OcrInput): void;
  onFailure(input: OcrInput, message: string): void;
}): TaskDef<OcrInput, OcrOutput> {
  return {
    kind: 'ocr_pages',
    schema: ocrOutput,
    timeoutMs: 6 * 60_000,
    tools: 'read',
    async prepare(input, workDir) {
      if (isPdf(input.mime)) await renderPdfPages(new Uint8Array(readFileSync(input.path)), input.pages, workDir);
      else copyFileSync(input.path, join(workDir, imageNames(input)[0]!));
    },
    vars(input) {
      const names = imageNames(input);
      const mapping = names.map((n, i) => `- ${n} = الصفحة ${input.pages[i]}`).join('\n');
      return { mapping, count: String(input.pages.length) };
    },
    check(output, input) {
      const problems: string[] = [];
      const got = output.pages.map((p) => p.page).sort((a, b) => a - b);
      const want = [...input.pages].sort((a, b) => a - b);
      if (got.join(',') !== want.join(',')) {
        problems.push(`أرقام الصفحات في الرد (${got.join(', ')}) يجب أن تكون بالضبط: ${want.join(', ')}`);
      }
      for (const p of output.pages) {
        if (p.result === 'read' && !p.text.trim()) problems.push(`الصفحة ${p.page}: result=read لكن النص فارغ`);
        if (p.result === 'unreadable' && !p.note) problems.push(`الصفحة ${p.page}: اذكر سبب تعذّر القراءة في note`);
      }
      return problems;
    },
    onSuccess: hooks.onSuccess,
    onFailure: hooks.onFailure,
  };
}
