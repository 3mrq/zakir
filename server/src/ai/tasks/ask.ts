// «اسأل المادة»: answer from the retrieved pages only, every segment cited, honest "not found".
// expand_query is a small, optional call used only when local search finds too little
// (e.g. an Arabic question about English-only material).

import type { Dialect } from '@zakir/shared';
import { z } from 'zod';
import { aiRef, checkRefs, formatSources, sentSet, type TaskDef } from '../task.ts';

// ---------- query expansion ----------

export interface ExpandInput {
  askId: number;
  question: string;
  outline: string;
}

export const expandOutput = z.object({ terms: z.array(z.string().min(1)) });
export type ExpandOutput = z.infer<typeof expandOutput>;

export function makeExpandTask(hooks: {
  onSuccess(out: ExpandOutput, input: ExpandInput): void;
  onFailure(input: ExpandInput, message: string): void;
}): TaskDef<ExpandInput, ExpandOutput> {
  return {
    kind: 'expand_query',
    schema: expandOutput,
    timeoutMs: 2 * 60_000,
    tools: 'none',
    vars: (input) => ({ question: input.question, outline: input.outline }),
    check: (out) => (out.terms.length < 2 || out.terms.length > 15 ? [`terms يجب أن تكون بين 2 و15 (الآن ${out.terms.length})`] : []),
    onSuccess: hooks.onSuccess,
    onFailure: hooks.onFailure,
  };
}

// ---------- answer ----------

export const MAX_ASK_CHARS = 120_000;

export interface AskInput {
  askId: number;
  question: string;
  dialect: Dialect;
  scopeLabel: string;
  history: { question: string; answer: string }[];
  pages: { fileId: number; page: number; text: string }[];
}

export const askOutput = z.object({
  found: z.enum(['yes', 'partial', 'no']),
  segments: z.array(z.object({ text: z.string().min(1), refs: z.array(aiRef) })),
  missing: z.string(),
});
export type AskOutput = z.infer<typeof askOutput>;

const DIALECT_RULES: Record<Dialect, string> = {
  fusha: 'اكتب بالعربية الفصحى الواضحة والسهلة، بجمل قصيرة، كأنك أستاذ يشرح لطالبه.',
  saudi:
    'اكتب باللهجة السعودية البيضاء المفهومة (مثل: "يعني"، "عشان"، "كذا"، "وش"، "لأن الفكرة إن...")، بأسلوب صديق يشرح لصاحبه قبل الاختبار، بدون مبالغة في العامية وبدون أخطاء علمية.',
};

export function makeAskTask(hooks: {
  onSuccess(out: AskOutput, input: AskInput): void;
  onFailure(input: AskInput, message: string): void;
}): TaskDef<AskInput, AskOutput> {
  return {
    kind: 'ask',
    schema: askOutput,
    timeoutMs: 5 * 60_000,
    tools: 'none',
    vars: (input) => ({
      question: input.question,
      dialect: DIALECT_RULES[input.dialect],
      scope: input.scopeLabel,
      history: input.history.length
        ? input.history.map((h, i) => `سؤال ${i + 1}: ${h.question}\nجواب ${i + 1}: ${h.answer}`).join('\n\n')
        : '(لا يوجد)',
      sources: formatSources(input.pages.map((p) => ({ file: `F${p.fileId}`, page: p.page, text: p.text }))),
    }),
    check: (out, input) => {
      const problems: string[] = [];
      const sent = sentSet(input.pages);
      if (out.found !== 'no' && !out.segments.length) problems.push('found ليس "no" لكن لا توجد segments');
      if (out.found !== 'yes' && !out.missing.trim()) problems.push('اذكر في missing ما الذي لا تغطيه الملفات');
      out.segments.forEach((s, i) => {
        if (!s.refs.length) problems.push(`الفقرة ${i + 1} بلا مرجع: «${s.text.slice(0, 60)}»`);
        problems.push(...checkRefs(s.refs, sent, `الفقرة ${i + 1}`));
      });
      return problems;
    },
    onSuccess: hooks.onSuccess,
    onFailure: hooks.onFailure,
  };
}
