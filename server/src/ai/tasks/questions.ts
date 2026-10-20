// Question generation (from chapter pages, in the doctor's style when known) and an independent
// verification pass that checks every question against its cited pages before it can be shown.

import type { Difficulty, QuestionType, StyleProfile } from '@zakir/shared';
import { QUESTION_TYPE_LABEL } from '@zakir/shared';
import { z } from 'zod';
import { aiRef, checkRefs, formatSources, sentSet, type TaskDef } from '../task.ts';

export const MAX_GENERATE_CHARS = 250_000;
export const MAX_COUNT = 20;

// ---------- generation ----------

export interface GenerateInput {
  setId: number;
  type: QuestionType | 'mixed';
  difficulty: Difficulty | 'mixed';
  count: number;
  chapters: { id: number; title: string; pages: { fileId: number; page: number; text: string }[] }[];
  style: StyleProfile | null;
}

const generated = z.object({
  type: z.enum(['mcq', 'true_false', 'short_answer', 'essay']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  chapter: z.string(),
  stem: z.string().min(1),
  options: z.array(z.string()).optional(),
  correctIndex: z.number().int().optional(),
  optionExplanations: z.array(z.string()).optional(),
  correct: z.boolean().optional(),
  modelAnswer: z.string().optional(),
  keyPoints: z.array(z.object({ text: z.string().min(1), refs: z.array(aiRef) })).optional(),
  explanation: z.string().min(1),
  refs: z.array(aiRef).min(1),
});
export const generateOutput = z.object({ questions: z.array(generated) });
export type GeneratedQuestion = z.infer<typeof generated>;
export type GenerateOutput = z.infer<typeof generateOutput>;

function styleText(style: StyleProfile | null): string {
  if (!style) return 'لا يوجد ملف أسلوب لهذه المادة بعد. اكتب أسئلة جامعية واضحة بلغة المادة.';
  const lines = [
    `لغة الأسئلة: ${style.language}`,
    `بنية الاختبار: ${style.structure}`,
    `توزيع الأنواع في اختباراته: ${style.types.map((t) => `${t.type === 'other' ? 'أخرى' : QUESTION_TYPE_LABEL[t.type]} ${t.percent}%`).join('، ')}`,
    'ملاحظات الصياغة:',
    ...style.phrasing.map((p) => `- ${p}`),
    'أمثلة حرفية من اختباراته (للأسلوب فقط — لا تنسخها ولا تأخذ منها معلومات):',
    ...style.examples.slice(0, 5).map((e) => `- ${e.text.replace(/\s+/g, ' ')}`),
  ];
  if (style.recurringTopics.length) lines.push(`مواضيع يكررها: ${style.recurringTopics.slice(0, 8).map((t) => t.topic).join('، ')}`);
  return lines.join('\n');
}

const words = (s: string) => new Set(s.toLowerCase().replace(/\(\s*\d+\s*marks?\s*\)/g, '').match(/[\p{L}\p{N}]+/gu) ?? []);

/** Word-overlap (Jaccard) between a generated stem and a past-exam example's first line. */
export function overlap(a: string, b: string): number {
  const A = words(a);
  const B = words(b.split('\n')[0] ?? '');
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / (A.size + B.size - common);
}

const COPY_THRESHOLD = 0.8;

function checkQuestion(q: GeneratedQuestion, i: number, input: GenerateInput, sent: Set<string>): string[] {
  const p: string[] = [];
  const at = `السؤال ${i + 1}`;
  if (input.type !== 'mixed' && q.type !== input.type) p.push(`${at}: النوع يجب أن يكون ${input.type}`);
  if (input.difficulty !== 'mixed' && q.difficulty !== input.difficulty) p.push(`${at}: الصعوبة يجب أن تكون ${input.difficulty}`);
  if (!/^C\d+$/.test(q.chapter) || Number(q.chapter.slice(1)) > input.chapters.length || Number(q.chapter.slice(1)) < 1) {
    p.push(`${at}: chapter يجب أن يكون أحد الوسوم C1..C${input.chapters.length}`);
  }
  p.push(...checkRefs(q.refs, sent, at));
  const arabic = (s: string) => /[؀-ۿ]/.test(s);
  if (!arabic(q.explanation)) p.push(`${at}: explanation يجب أن يكون بالعربية الفصحى`);
  if (q.optionExplanations?.some((e) => !arabic(e))) p.push(`${at}: optionExplanations يجب أن تكون بالعربية الفصحى`);
  const copied = input.style?.examples.find((e) => overlap(q.stem, e.text) >= COPY_THRESHOLD);
  if (copied) p.push(`${at}: منسوخ تقريبًا من سؤال في اختبار سابق («${copied.text.split('\n')[0]!.slice(0, 80)}»). اكتب سؤالًا جديدًا بنفس الأسلوب لا بنفس النص`);
  if (q.type === 'mcq') {
    const n = q.options?.length ?? 0;
    if (n < 3 || n > 5) p.push(`${at}: الاختيار من متعدد يحتاج 3 إلى 5 خيارات`);
    else if (new Set(q.options!.map((o) => o.trim())).size !== n) p.push(`${at}: خيارات مكررة`);
    if (q.correctIndex === undefined || q.correctIndex < 0 || q.correctIndex >= n) p.push(`${at}: correctIndex غير صالح`);
    if (q.optionExplanations?.length !== n) p.push(`${at}: optionExplanations يجب أن تشرح كل خيار (${n})`);
  }
  if (q.type === 'true_false' && q.correct === undefined) p.push(`${at}: correct مطلوب لسؤال صح وخطأ`);
  if (q.type === 'short_answer' || q.type === 'essay') {
    if (!q.modelAnswer?.trim()) p.push(`${at}: modelAnswer مطلوب`);
    if (!q.keyPoints?.length || q.keyPoints.length > 8) p.push(`${at}: keyPoints مطلوبة (1 إلى 8 نقاط تصحيح)`);
    q.keyPoints?.forEach((k, j) => {
      if (!k.refs.length) p.push(`${at}: نقطة التصحيح ${j + 1} بلا مرجع`);
      p.push(...checkRefs(k.refs, sent, `${at}، نقطة التصحيح ${j + 1}`));
    });
  }
  return p;
}

export function makeGenerateTask(hooks: {
  onSuccess(out: GenerateOutput, input: GenerateInput): void;
  onFailure(input: GenerateInput, message: string): void;
}): TaskDef<GenerateInput, GenerateOutput> {
  return {
    kind: 'generate_questions',
    schema: generateOutput,
    timeoutMs: 10 * 60_000,
    tools: 'none',
    vars: (input) => ({
      count: String(input.count),
      type: input.type === 'mixed' ? 'منوّعة (حسب توزيع أنواع أسئلة الدكتور إن وُجد، وإلا منوّعة بين الأنواع الأربعة)' : `${input.type} (${QUESTION_TYPE_LABEL[input.type]})`,
      difficulty: input.difficulty === 'mixed' ? 'منوّعة' : input.difficulty,
      style: styleText(input.style),
      sources: input.chapters
        .map((c, i) => `### C${i + 1}: ${c.title}\n${formatSources(c.pages.map((p) => ({ file: `F${p.fileId}`, page: p.page, text: p.text })))}`)
        .join('\n\n'),
    }),
    check: (out, input) => {
      const sent = sentSet(input.chapters.flatMap((c) => c.pages));
      const problems: string[] = [];
      if (out.questions.length !== input.count) problems.push(`المطلوب ${input.count} سؤالًا بالضبط (الآن ${out.questions.length})`);
      const stems = new Set<string>();
      out.questions.forEach((q, i) => {
        const key = q.stem.trim().replace(/\s+/g, ' ');
        if (stems.has(key)) problems.push(`السؤال ${i + 1} مكرر`);
        stems.add(key);
        problems.push(...checkQuestion(q, i, input, sent));
      });
      return problems;
    },
    onSuccess: hooks.onSuccess,
    onFailure: hooks.onFailure,
  };
}

// ---------- verification ----------

export interface VerifyInput {
  setId: number;
  questions: { id: number; text: string; refs: { fileId: number; page: number }[] }[];
  pages: { fileId: number; page: number; text: string }[];
}

export const verifyOutput = z.object({
  results: z.array(z.object({ question: z.string().regex(/^Q\d+$/), verdict: z.enum(['ok', 'reject']), reason: z.string() })),
});
export type VerifyOutput = z.infer<typeof verifyOutput>;

export function makeVerifyTask(hooks: {
  onSuccess(out: VerifyOutput, input: VerifyInput): void;
  onFailure(input: VerifyInput, message: string): void;
}): TaskDef<VerifyInput, VerifyOutput> {
  return {
    kind: 'verify_questions',
    schema: verifyOutput,
    timeoutMs: 10 * 60_000,
    tools: 'none',
    vars: (input) => ({
      sources: formatSources(input.pages.map((p) => ({ file: `F${p.fileId}`, page: p.page, text: p.text }))),
      questions: input.questions.map((q) => `=== Q${q.id}\n${q.text}`).join('\n\n'),
      count: String(input.questions.length),
    }),
    check: (out, input) => {
      const want = input.questions.map((q) => `Q${q.id}`).sort();
      const got = out.results.map((r) => r.question).sort();
      const problems: string[] = [];
      if (want.join(',') !== got.join(',')) problems.push(`يجب حكم واحد لكل سؤال بالضبط: ${want.join(', ')}`);
      out.results.forEach((r) => r.verdict === 'reject' && !r.reason.trim() && problems.push(`${r.question}: اذكر سبب الاستبعاد`));
      return problems;
    },
    onSuccess: hooks.onSuccess,
    onFailure: hooks.onFailure,
  };
}
