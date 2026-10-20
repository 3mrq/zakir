import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.ts';
import { openDb, type DB } from '../db/index.ts';
import { AIError } from './errors.ts';
import type { AIProvider, AIRequest, AIResponse } from './provider.ts';
import { JobQueue } from './queue.ts';
import { smokeTestTask } from './tasks/smokeTest.ts';

type Script = (req: AIRequest, signal: AbortSignal) => Promise<unknown>;

/** Fake provider: each call takes the next scripted behaviour. Records concurrency. */
class FakeProvider implements AIProvider {
  readonly id = 'fake';
  calls: AIRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private script: Script[]) {}
  async healthCheck() {
    return { provider: 'fake', code: 'ok' as const, message: 'ok' };
  }
  async run(req: AIRequest, signal: AbortSignal): Promise<AIResponse> {
    this.calls.push(req);
    const step = this.script.shift() ?? (async () => good);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return { data: await step(req, signal), meta: {} };
    } finally {
      this.inFlight--;
    }
  }
}

const good = { found: true, answer: 'في الميتوكوندريا', refs: [{ file: 'F1', page: 4 }] };
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason === 'timeout' ? new AIError('TIMEOUT') : new AIError('CANCELLED'));
    });
  });

let tmp: string;
let db: DB;
const makeQueue = (p: AIProvider, concurrency = 2) =>
  new JobQueue(db, p, { concurrency, model: 'sonnet', promptsDir: config.promptsDir, workRoot: join(tmp, 'work') });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'zakir-test-'));
  db = openDb(join(tmp, 't.db'));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('JobQueue', () => {
  it('runs a task, renders the prompt file, and logs to ai_jobs', async () => {
    const p = new FakeProvider([async () => good]);
    const q = makeQueue(p);
    const job = q.enqueue(smokeTestTask, { question: 'أين ATP؟' });
    expect(job.status).toBe('queued');
    await q.idle();
    const done = q.get(job.id)!;
    expect(done.status).toBe('done');
    expect(done.result).toEqual(good);
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(p.calls[0]!.user).toContain('[F1:p4]');
    expect(p.calls[0]!.user).toContain('أين ATP؟');
    expect(p.calls[0]!.tools).toBe('none');
    expect(p.calls[0]!.jsonSchema).toHaveProperty('properties.refs');
  });

  it('never runs more than `concurrency` jobs at once', async () => {
    const slow: Script = async (_r, s) => (await wait(30, s), good);
    const p = new FakeProvider([slow, slow, slow, slow, slow]);
    const q = makeQueue(p, 2);
    for (let i = 0; i < 5; i++) q.enqueue(smokeTestTask, { question: `س${i}` });
    await q.idle();
    expect(p.maxInFlight).toBe(2);
    expect(q.list().every((j) => j.status === 'done')).toBe(true);
  });

  it('retries once with feedback when output fails the schema, then succeeds', async () => {
    const p = new FakeProvider([async () => ({ found: 'yes' }), async () => good]);
    const q = makeQueue(p);
    const job = q.enqueue(smokeTestTask, { question: 'س' });
    await q.idle();
    const done = q.get(job.id)!;
    expect(done.status).toBe('done');
    expect(done.attempts).toBe(2);
    expect(p.calls[1]!.user).toContain('ردك السابق لم يكن صالحًا');
  });

  it('fails clearly after two invalid outputs', async () => {
    const p = new FakeProvider([async () => ({}), async () => ({})]);
    const q = makeQueue(p);
    const job = q.enqueue(smokeTestTask, { question: 'س' });
    await q.idle();
    const failed = q.get(job.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('INVALID_OUTPUT');
    expect(failed.error).toContain('لم يطابق الشكل المطلوب');
  });

  it('treats a citation to a page we did not send as invalid (task check)', async () => {
    const bad = { ...good, refs: [{ file: 'F9', page: 99 }] };
    const p = new FakeProvider([async () => bad, async () => bad]);
    const q = makeQueue(p);
    const job = q.enqueue(smokeTestTask, { question: 'س' });
    await q.idle();
    expect(q.get(job.id)!.errorCode).toBe('INVALID_OUTPUT');
    expect(p.calls[1]!.user).toContain('F9:p99');
  });

  it('does not retry provider errors such as not logged in', async () => {
    const p = new FakeProvider([async () => { throw new AIError('NOT_LOGGED_IN'); }]);
    const q = makeQueue(p);
    const job = q.enqueue(smokeTestTask, { question: 'س' });
    await q.idle();
    const failed = q.get(job.id)!;
    expect(p.calls).toHaveLength(1);
    expect(failed.errorCode).toBe('NOT_LOGGED_IN');
    expect(failed.error).toContain('claude auth login');
  });

  it('times out a slow job', async () => {
    const p = new FakeProvider([async (_r, s) => (await wait(5_000, s), good)]);
    const q = makeQueue(p);
    const job = q.enqueue({ ...smokeTestTask, timeoutMs: 50 }, { question: 'س' });
    await q.idle();
    const failed = q.get(job.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('TIMEOUT');
  });

  it('cancels running and waiting jobs', async () => {
    const slow: Script = async (_r, s) => (await wait(5_000, s), good);
    const p = new FakeProvider([slow]);
    const q = makeQueue(p, 1);
    const a = q.enqueue(smokeTestTask, { question: 'أ' });
    const b = q.enqueue(smokeTestTask, { question: 'ب' });
    await new Promise((r) => setTimeout(r, 20));
    expect(q.cancel(b.id)).toBe(true); // waiting
    expect(q.cancel(a.id)).toBe(true); // running
    await q.idle();
    expect(q.get(a.id)!.status).toBe('cancelled');
    expect(q.get(b.id)!.status).toBe('cancelled');
    expect(p.calls).toHaveLength(1);
  });

  it('marks jobs left from a previous run as failed on startup', () => {
    db.prepare(`INSERT INTO ai_jobs (kind, status) VALUES ('smoke_test', 'running')`).run();
    makeQueue(new FakeProvider([]));
    const row = db.prepare(`SELECT status, error_code FROM ai_jobs`).get() as { status: string; error_code: string };
    expect(row).toEqual({ status: 'failed', error_code: 'SERVER_RESTART' });
  });
});
