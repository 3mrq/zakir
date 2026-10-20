// Grades a written answer (short answer / essay) against the question's key points and cited pages.
// The score is computed locally from the key-point verdicts, so it is consistent and explainable.

import { z } from 'zod';
import { aiRef, checkRefs, formatSources, sentSet, type TaskDef } from '../task.ts';

export interface GradeInput {
  attemptId: number;
  type: 'short_answer' | 'essay';
  stem: string;
  modelAnswer: string;
  keyPoints: string[];
  answer: string;
  pages: { fileId: number; page: number; text: string }[];
}

export const gradeOutput = z.object({
  keyPoints: z.array(z.object({ index: z.number().int(), status: z.enum(['covered', 'partial', 'missing']), note: z.string() })),
  mistakes: z.array(z.object({ quote: z.string().min(1), why: z.string().min(1), refs: z.array(aiRef) })),
  summary: z.string().min(1),
});
export type GradeOutput = z.infer<typeof gradeOutput>;

const WEIGHT = { covered: 1, partial: 0.5, missing: 0 } as const;

export function scoreFromKeyPoints(kp: GradeOutput['keyPoints']): number {
  if (!kp.length) return 0;
  return Math.round((kp.reduce((n, k) => n + WEIGHT[k.status], 0) / kp.length) * 100) / 100;
}

export function makeGradeTask(hooks: {
  onSuccess(out: GradeOutput, input: GradeInput): void;
  onFailure(input: GradeInput, message: string): void;
}): TaskDef<GradeInput, GradeOutput> {
  return {
    kind: 'grade_answer',
    schema: gradeOutput,
    timeoutMs: 5 * 60_000,
    tools: 'none',
    vars: (input) => ({
      stem: input.stem,
      modelAnswer: input.modelAnswer,
      keyPoints: input.keyPoints.map((k, i) => `${i}. ${k}`).join('\n'),
      answer: input.answer.trim() || '(لم يكتب الطالب شيئًا)',
      sources: formatSources(input.pages.map((p) => ({ file: `F${p.fileId}`, page: p.page, text: p.text }))),
    }),
    check: (out, input) => {
      const problems: string[] = [];
      const idx = out.keyPoints.map((k) => k.index).sort((a, b) => a - b);
      const want = input.keyPoints.map((_, i) => i);
      if (idx.join(',') !== want.join(',')) problems.push(`احكم على كل نقطة تصحيح مرة واحدة بالأرقام: ${want.join(', ')}`);
      const sent = sentSet(input.pages);
      out.mistakes.forEach((m, i) => problems.push(...checkRefs(m.refs, sent, `الخطأ ${i + 1}`)));
      return problems;
    },
    onSuccess: hooks.onSuccess,
    onFailure: hooks.onFailure,
  };
}
