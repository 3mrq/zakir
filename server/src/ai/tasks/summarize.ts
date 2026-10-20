// Summarizes one chapter at two levels (quick + detailed) in a single call, every point cited.

import { z } from 'zod';
import { formatSources, type TaskDef } from '../task.ts';

/** ~100k tokens of Arabic/English text; larger chapters must be split by the user. */
export const MAX_SUMMARY_CHARS = 300_000;

export interface SummarizeInput {
  chapterId: number;
  title: string;
  topics: string[];
  pages: { fileId: number; page: number; text: string }[];
  /** Hash of the chapter's pages at request time (stored with the summary). */
  sourceHash: string;
}

const ref = z.object({ file: z.string().regex(/^F\d+$/), page: z.number().int().positive() });
const point = z.object({ text: z.string().min(1), refs: z.array(ref) });

export const summarizeOutput = z.object({
  quick: z.array(point),
  detailed: z.array(z.object({ heading: z.string().min(1), points: z.array(point).min(1) })),
});
export type SummarizeOutput = z.infer<typeof summarizeOutput>;

export function makeSummarizeTask(hooks: { onSuccess(out: SummarizeOutput, input: SummarizeInput): void }): TaskDef<SummarizeInput, SummarizeOutput> {
  return {
    kind: 'summarize',
    schema: summarizeOutput,
    timeoutMs: 10 * 60_000,
    tools: 'none',
    vars: (input) => ({
      title: input.title,
      topics: input.topics.length ? input.topics.map((t) => `- ${t}`).join('\n') : '(لا توجد مواضيع محددة)',
      sources: formatSources(input.pages.map((p) => ({ file: `F${p.fileId}`, page: p.page, text: p.text }))),
    }),
    check: (out, input) => {
      const problems: string[] = [];
      const sent = new Set(input.pages.map((p) => `F${p.fileId}:${p.page}`));
      if (out.quick.length < 3 || out.quick.length > 15) problems.push(`الملخص السريع يجب أن يكون بين 3 و15 نقطة (الآن ${out.quick.length})`);
      if (!out.detailed.length) problems.push('الملخص المفصّل فارغ');
      const all = [...out.quick.map((p) => ['السريع', p] as const), ...out.detailed.flatMap((s) => s.points.map((p) => [`«${s.heading}»`, p] as const))];
      for (const [where, p] of all) {
        if (!p.refs.length) problems.push(`نقطة في ${where} بلا مرجع: «${p.text.slice(0, 60)}»`);
        for (const r of p.refs) {
          if (!sent.has(`${r.file}:${r.page}`)) problems.push(`المرجع ${r.file}:p${r.page} غير موجود في صفحات الشابتر المرسلة`);
        }
      }
      return [...new Set(problems)];
    },
    onSuccess: hooks.onSuccess,
  };
}
