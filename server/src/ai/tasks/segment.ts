// Splits a subject's content files into chapters and topics from a compact page outline
// (first line(s) of every page), not the full text — enough to see headings, cheap on quota.

import type { ChapterInput } from '@zakir/shared';
import { z } from 'zod';
import type { ContentFile } from '../../study/chapters.ts';
import type { TaskDef } from '../task.ts';

export interface SegmentInput {
  subjectId: number;
  files: ContentFile[];
  pages: { fileId: number; page: number; text: string }[];
}

const fileTag = z.string().regex(/^F\d+$/, 'file يجب أن يكون بالشكل F<رقم> كما في المخطط');
const range = z.object({ file: fileTag, from: z.number().int(), to: z.number().int() });

export const segmentOutput = z.object({
  chapters: z
    .array(
      z.object({
        title: z.string(),
        ranges: z.array(range),
        topics: z.array(range.extend({ title: z.string() })),
      }),
    )
    .min(1),
});
type SegmentOutput = z.infer<typeof segmentOutput>;

const OUTLINE_CHARS = 180;

export function buildOutline(input: SegmentInput): string {
  return input.files
    .map((f) => {
      const lines = input.pages
        .filter((p) => p.fileId === f.id)
        .map((p) => {
          const head = p.text.replace(/\s+/g, ' ').trim().slice(0, OUTLINE_CHARS);
          return `p${p.page}: ${head || '(بلا نص)'}`;
        });
      return `=== F${f.id} — «${f.name}» — ${f.pageCount} صفحة\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

export function toChapterInputs(out: SegmentOutput): ChapterInput[] {
  const id = (tag: string) => Number(tag.slice(1));
  return out.chapters.map((c) => ({
    title: c.title,
    ranges: c.ranges.map((r) => ({ fileId: id(r.file), from: r.from, to: r.to })),
    topics: c.topics.map((t) => ({ title: t.title, fileId: id(t.file), from: t.from, to: t.to })),
  }));
}

/** Pages not covered by any chapter — reported back so the model can fix gaps. */
function uncovered(chapters: ChapterInput[], files: ContentFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const missing: number[] = [];
    for (let p = 1; p <= f.pageCount; p++) {
      const covered = chapters.some((c) => c.ranges.some((r) => r.fileId === f.id && r.from <= p && p <= r.to));
      if (!covered) missing.push(p);
    }
    if (missing.length) out.push(`صفحات من F${f.id} غير مغطاة بأي شابتر: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`);
  }
  return out;
}

export function makeSegmentTask(hooks: {
  onSuccess(chapters: ChapterInput[], input: SegmentInput): void;
  check(chapters: ChapterInput[], input: SegmentInput): string[];
}): TaskDef<SegmentInput, SegmentOutput> {
  return {
    kind: 'segment',
    schema: segmentOutput,
    timeoutMs: 6 * 60_000,
    tools: 'none',
    vars: (input) => ({ outline: buildOutline(input), fileCount: String(input.files.length) }),
    check: (out, input) => {
      const chapters = toChapterInputs(out);
      return [...hooks.check(chapters, input), ...uncovered(chapters, input.files)];
    },
    onSuccess: (out, input) => hooks.onSuccess(toChapterInputs(out), input),
  };
}
