// Smoke test task: answers a question from fixed sample sources, with citations.
// It exercises the same contract real tasks will use: tagged sources in, cited JSON out, "not found" when absent.

import { z } from 'zod';
import { formatSources, type TaskDef } from '../task.ts';

export const SAMPLE_PAGES = [
  { file: 'F1', page: 3, text: 'الخلية (Cell) هي الوحدة الأساسية للحياة. تحتوي الخلية حقيقية النواة (Eukaryotic cell) على نواة محاطة بغشاء.' },
  { file: 'F1', page: 4, text: 'الميتوكوندريا (Mitochondria) هي مكان التنفس الخلوي (Cellular respiration) وإنتاج ATP.' },
];

export const smokeTestOutput = z.object({
  found: z.boolean(),
  answer: z.string().min(1),
  refs: z.array(z.object({ file: z.string(), page: z.number().int().positive() })),
});

export type SmokeTestInput = { question: string };

export const smokeTestTask: TaskDef<SmokeTestInput, z.infer<typeof smokeTestOutput>> = {
  kind: 'smoke_test',
  schema: smokeTestOutput,
  timeoutMs: 120_000,
  tools: 'none',
  vars: ({ question }) => ({ sources: formatSources(SAMPLE_PAGES), question }),
  check: (out) => {
    const problems: string[] = [];
    if (out.found && out.refs.length === 0) problems.push('found=true لكن refs فارغة: كل معلومة تحتاج مرجعًا');
    for (const r of out.refs) {
      if (!SAMPLE_PAGES.some((p) => p.file === r.file && p.page === r.page)) {
        problems.push(`المرجع ${r.file}:p${r.page} غير موجود في المصادر المرسلة`);
      }
    }
    return problems;
  },
};
