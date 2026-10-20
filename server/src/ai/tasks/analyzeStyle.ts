// Analyzes a subject's past exams: question types, chapter distribution, recurring topics, phrasing.
// Counting is done by the model over the full exam text; percentages and confidence are computed locally.

import { z } from 'zod';
import { aiRef, checkRefs, formatSources, sentSet, type TaskDef } from '../task.ts';

export const MAX_STYLE_CHARS = 300_000;

export interface AnalyzeStyleInput {
  subjectId: number;
  fileIds: number[];
  pages: { fileId: number; page: number; text: string }[];
  /** Subject chapters, tagged C1..Cn in the prompt. */
  chapters: { id: number; title: string; topics: string[] }[];
}

const qtype = z.enum(['mcq', 'true_false', 'short_answer', 'essay', 'other']);

export const analyzeStyleOutput = z.object({
  examsDetected: z.number().int().min(1),
  totalQuestions: z.number().int().min(1),
  language: z.string().min(1),
  structure: z.string().min(1),
  types: z.array(z.object({ type: qtype, count: z.number().int().min(0) })),
  chapters: z.array(z.object({ chapter: z.string(), count: z.number().int().min(0) })),
  recurringTopics: z.array(z.object({ topic: z.string().min(1), count: z.number().int().min(1), refs: z.array(aiRef) })),
  phrasing: z.array(z.string().min(1)),
  examples: z.array(z.object({ type: qtype, text: z.string().min(1), refs: z.array(aiRef).min(1) })),
});
export type AnalyzeStyleOutput = z.infer<typeof analyzeStyleOutput>;

export function makeAnalyzeStyleTask(hooks: {
  onSuccess(out: AnalyzeStyleOutput, input: AnalyzeStyleInput): void;
}): TaskDef<AnalyzeStyleInput, AnalyzeStyleOutput> {
  return {
    kind: 'analyze_style',
    schema: analyzeStyleOutput,
    timeoutMs: 10 * 60_000,
    tools: 'none',
    vars: (input) => ({
      chapters: input.chapters.length
        ? input.chapters.map((c, i) => `C${i + 1}: ${c.title}${c.topics.length ? ` — المواضيع: ${c.topics.join('، ')}` : ''}`).join('\n')
        : '(لم تُقسَّم المادة إلى شباترات بعد — استخدم "none" لكل الأسئلة)',
      exams: formatSources(input.pages.map((p) => ({ file: `F${p.fileId}`, page: p.page, text: p.text }))),
      fileCount: String(input.fileIds.length),
    }),
    check: (out, input) => {
      const problems: string[] = [];
      const sent = sentSet(input.pages);
      const sum = (xs: { count: number }[]) => xs.reduce((n, x) => n + x.count, 0);
      if (sum(out.types) !== out.totalQuestions) problems.push(`مجموع types (${sum(out.types)}) يجب أن يساوي totalQuestions (${out.totalQuestions})`);
      if (sum(out.chapters) !== out.totalQuestions) problems.push(`مجموع chapters (${sum(out.chapters)}) يجب أن يساوي totalQuestions (${out.totalQuestions})`);
      const validTags = new Set(['none', ...input.chapters.map((_, i) => `C${i + 1}`)]);
      for (const c of out.chapters) if (!validTags.has(c.chapter)) problems.push(`الشابتر "${c.chapter}" غير موجود في القائمة (المسموح: ${[...validTags].join(', ')})`);
      if (out.examples.length < 2 || out.examples.length > 8) problems.push(`examples يجب أن تكون بين 2 و8 أسئلة (الآن ${out.examples.length})`);
      out.recurringTopics.forEach((t) => problems.push(...checkRefs(t.refs, sent, `الموضوع «${t.topic}»`)));
      out.examples.forEach((e, i) => problems.push(...checkRefs(e.refs, sent, `المثال ${i + 1}`)));
      return problems;
    },
    onSuccess: hooks.onSuccess,
  };
}
