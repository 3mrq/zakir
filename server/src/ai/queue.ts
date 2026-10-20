// Job queue for AI tasks: limited concurrency, timeout, cancel, Zod validation with one retry,
// and a persistent log in the ai_jobs table.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { JobDTO, JobStatus } from '@zakir/shared';
import { z } from 'zod';
import type { DB } from '../db/index.ts';
import { AIError } from './errors.ts';
import { loadPrompt, render } from './prompts.ts';
import type { AIProvider } from './provider.ts';
import type { TaskDef } from './task.ts';

const MAX_ATTEMPTS = 2;

interface Pending {
  id: number;
  def: TaskDef<any, any>;
  input: unknown;
  controller: AbortController;
  ref?: { type: string; id: number };
}

interface Row {
  id: number;
  kind: string;
  status: JobStatus;
  model: string | null;
  attempts: number;
  result_json: string | null;
  error_code: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  ref_type: string | null;
  ref_id: number | null;
}

const toDTO = (r: Row): JobDTO => ({
  id: r.id,
  kind: r.kind as JobDTO['kind'],
  status: r.status,
  model: r.model,
  attempts: r.attempts,
  errorCode: r.error_code,
  error: r.error,
  result: r.result_json ? JSON.parse(r.result_json) : null,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.duration_ms,
  refType: r.ref_type,
  refId: r.ref_id,
});

export interface QueueOptions {
  concurrency: number;
  model: string;
  promptsDir: string;
  workRoot: string;
  onSettled?: (job: JobDTO) => void;
}

export class JobQueue {
  private waiting: Pending[] = [];
  private running = new Map<number, Pending>();

  constructor(
    private readonly db: DB,
    private readonly provider: AIProvider,
    private readonly opts: QueueOptions,
  ) {
    // Jobs left over from a previous server run cannot resume (their input lived in memory).
    db.prepare(
      `UPDATE ai_jobs SET status='failed', error_code='SERVER_RESTART', error=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE status IN ('queued','running')`,
    ).run(new AIError('SERVER_RESTART').userMessage);
  }

  enqueue<I, O>(def: TaskDef<I, O>, input: I, ref?: { type: string; id: number }): JobDTO {
    const model = def.model ?? this.opts.model;
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO ai_jobs (kind, status, model, input_json, ref_type, ref_id) VALUES (?, 'queued', ?, ?, ?, ?)`)
      .run(def.kind, model, JSON.stringify(input), ref?.type ?? null, ref?.id ?? null);
    const id = Number(lastInsertRowid);
    this.waiting.push({ id, def, input, controller: new AbortController(), ref });
    queueMicrotask(() => this.pump());
    return this.get(id)!;
  }

  cancel(id: number): boolean {
    const i = this.waiting.findIndex((p) => p.id === id);
    if (i >= 0) {
      const [p] = this.waiting.splice(i, 1);
      const err = new AIError('CANCELLED');
      this.finish(id, 'cancelled', null, err);
      this.notifyFailure(p!, err);
      return true;
    }
    const p = this.running.get(id);
    if (p) {
      p.controller.abort('cancel');
      return true;
    }
    return false;
  }

  /** Cancels every waiting or running job attached to a record (e.g. a deleted file). */
  cancelByRef(type: string, id: number) {
    const ids = [...this.waiting, ...this.running.values()].filter((p) => p.ref?.type === type && p.ref.id === id).map((p) => p.id);
    ids.forEach((jobId) => this.cancel(jobId));
  }

  get(id: number): JobDTO | undefined {
    const r = this.db.prepare(`SELECT * FROM ai_jobs WHERE id = ?`).get(id) as Row | undefined;
    return r && toDTO(r);
  }

  list(limit = 50, ref?: { type: string; id: number }): JobDTO[] {
    const rows = ref
      ? this.db.prepare(`SELECT * FROM ai_jobs WHERE ref_type = ? AND ref_id = ? ORDER BY id DESC LIMIT ?`).all(ref.type, ref.id, limit)
      : this.db.prepare(`SELECT * FROM ai_jobs ORDER BY id DESC LIMIT ?`).all(limit);
    return (rows as Row[]).map(toDTO);
  }

  /** The waiting or running job of a given kind for a record, if any (to avoid duplicate work). */
  activeFor(kind: string, ref: { type: string; id: number }): JobDTO | undefined {
    const p = [...this.waiting, ...this.running.values()].find((x) => x.def.kind === kind && x.ref?.type === ref.type && x.ref.id === ref.id);
    return p && this.get(p.id);
  }

  /** Resolves when no job is waiting or running (used by tests and the CLI check). */
  async idle(): Promise<void> {
    while (this.waiting.length || this.running.size) await new Promise((r) => setTimeout(r, 20));
  }

  private pump() {
    while (this.running.size < this.opts.concurrency && this.waiting.length) {
      const p = this.waiting.shift()!;
      this.running.set(p.id, p);
      void this.execute(p).finally(() => {
        this.running.delete(p.id);
        this.pump();
      });
    }
  }

  private async execute(p: Pending) {
    const started = Date.now();
    this.db
      .prepare(`UPDATE ai_jobs SET status='running', started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(p.id);
    const timer = setTimeout(() => p.controller.abort('timeout'), p.def.timeoutMs);
    const workDir = join(this.opts.workRoot, `job-${p.id}`);
    try {
      mkdirSync(workDir, { recursive: true });
      await p.def.prepare?.(p.input, workDir);
      const output = await this.attempts(p, workDir);
      p.def.onSuccess?.(output, p.input);
      this.finish(p.id, 'done', output, undefined, Date.now() - started);
    } catch (e) {
      const err = e instanceof AIError ? e : new AIError('PROCESS_ERROR', e instanceof Error ? e.message : String(e));
      this.finish(p.id, err.code === 'CANCELLED' ? 'cancelled' : 'failed', null, err, Date.now() - started);
      this.notifyFailure(p, err);
    } finally {
      clearTimeout(timer);
      try {
        rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // A leftover empty work dir is harmless; never let cleanup take the server down.
      }
    }
  }

  /** Runs the task; if the output fails validation, retries once with the problems appended. */
  private async attempts(p: Pending, workDir: string): Promise<unknown> {
    const { def, input } = p;
    const tpl = loadPrompt(this.opts.promptsDir, def.kind);
    const vars = def.vars(input);
    const system = render(tpl.system, vars);
    const baseUser = render(tpl.user, vars);
    const jsonSchema = z.toJSONSchema(def.schema, { target: 'draft-7' });
    let user = baseUser;
    let lastProblems: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.db.prepare(`UPDATE ai_jobs SET attempts=? WHERE id=?`).run(attempt, p.id);
      let data: unknown;
      try {
        ({ data } = await this.provider.run(
          { system, user, jsonSchema, model: def.model ?? this.opts.model, tools: def.tools, workDir },
          p.controller.signal,
        ));
      } catch (e) {
        if (e instanceof AIError && e.code === 'INVALID_OUTPUT') {
          lastProblems = [e.detail ?? 'الرد ليس JSON'];
          user = withFeedback(baseUser, lastProblems);
          continue;
        }
        throw e;
      }
      const parsed = def.schema.safeParse(data);
      lastProblems = parsed.success
        ? (def.check?.(parsed.data, input) ?? [])
        : parsed.error.issues.map((i) => `${i.path.join('.') || '(الجذر)'}: ${i.message}`);
      if (parsed.success && lastProblems.length === 0) return parsed.data;
      user = withFeedback(baseUser, lastProblems);
    }
    throw new AIError('INVALID_OUTPUT', lastProblems.slice(0, 5).join('؛ '));
  }

  private notifyFailure(p: Pending, err: AIError) {
    try {
      p.def.onFailure?.(p.input, err.userMessage);
    } catch (e) {
      console.error('onFailure hook threw', e);
    }
  }

  private finish(id: number, status: JobStatus, result: unknown, err?: AIError, durationMs?: number) {
    this.db
      .prepare(
        `UPDATE ai_jobs SET status=?, result_json=?, error_code=?, error=?, duration_ms=?,
         finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      )
      .run(status, result == null ? null : JSON.stringify(result), err?.code ?? null, err?.userMessage ?? null, durationMs ?? null, id);
    const job = this.get(id);
    if (job) this.opts.onSettled?.(job);
  }
}

function withFeedback(user: string, problems: string[]): string {
  return `${user}\n\n---\nردك السابق لم يكن صالحًا للأسباب التالية:\n- ${problems.join('\n- ')}\nأعد الإجابة كاملة بالشكل المطلوب بعد تصحيح هذه المشكلات.`;
}
