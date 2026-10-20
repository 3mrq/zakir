// A task = prompt file + input → output schema. The queue runs tasks; the provider never sees Zod.

import type { PageRef, TaskKind } from '@zakir/shared';
import { z, type ZodType } from 'zod';

export interface TaskDef<I, O> {
  kind: TaskKind;
  schema: ZodType<O>;
  timeoutMs: number;
  tools: 'none' | 'read';
  /** Variables for the {{placeholders}} in prompts/<kind>.md. */
  vars(input: I): Record<string, string>;
  /** Extra checks the schema cannot express (e.g. every ref points to a page we sent). Returns problems, empty if fine. */
  check?(output: O, input: I): string[];
  /** Puts the files the task may read into its (empty, per-job) work directory. */
  prepare?(input: I, workDir: string): Promise<void>;
  /** Persists a validated result. Runs before the job is marked done; a throw fails the job. */
  onSuccess?(output: O, input: I): void;
  /** Called once when the job ends without a result (failed, timed out or cancelled). */
  onFailure?(input: I, errorMessage: string): void;
  model?: string;
}

/** A page reference as the AI writes it: {"file": "F12", "page": 7}. */
export const aiRef = z.object({ file: z.string().regex(/^F\d+$/), page: z.number().int().positive() });
export type AiRef = z.infer<typeof aiRef>;
export const toPageRef = (r: AiRef): PageRef => ({ fileId: Number(r.file.slice(1)), page: r.page });

/** Problems for refs that point to pages not sent in the prompt. */
export function checkRefs(refs: AiRef[], sent: Set<string>, where: string): string[] {
  return refs.filter((r) => !sent.has(`${r.file}:${r.page}`)).map((r) => `${where}: المرجع ${r.file}:p${r.page} ليس من الصفحات المرسلة`);
}

export const sentSet = (pages: { fileId: number; page: number }[]) => new Set(pages.map((p) => `F${p.fileId}:${p.page}`));

/** Wraps page texts as tagged sources: [F<fileId>:p<page>] text */
export function formatSources(pages: { file: string; page: number; text: string }[]): string {
  return pages.map((p) => `[${p.file}:p${p.page}]\n${p.text.trim()}`).join('\n\n');
}
