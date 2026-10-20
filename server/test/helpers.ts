// Test helpers: an app on a temp data dir with a scripted fake AI provider.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AIProvider, AIRequest, AIResponse } from '../src/ai/provider.ts';
import { buildApp } from '../src/app.ts';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (n: string) => readFileSync(join(FIXTURES, n));

type Kind = 'ocr' | 'segment' | 'summarize' | 'style' | 'generate' | 'verify' | 'grade' | 'expand' | 'ask' | 'other';

/** Which task a request is, from the shape of its output schema. */
export function kindOf(req: AIRequest): Kind {
  const props = (req.jsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
  if ('examsDetected' in props) return 'style';
  if ('chapters' in props) return 'segment';
  if ('quick' in props) return 'summarize';
  if ('questions' in props) return 'generate';
  if ('results' in props) return 'verify';
  if ('mistakes' in props) return 'grade';
  if ('terms' in props) return 'expand';
  if ('segments' in props) return 'ask';
  if ('pages' in props) return 'ocr';
  return 'other';
}

export class ScriptedProvider implements AIProvider {
  readonly id = 'fake';
  calls: { kind: Kind; req: AIRequest }[] = [];
  /** Responses per kind, consumed in order; the last one repeats. */
  script: Partial<Record<Kind, ((req: AIRequest) => unknown)[]>> = {};
  async healthCheck() {
    return { provider: 'fake', code: 'ok' as const, message: 'ok' };
  }
  async run(req: AIRequest): Promise<AIResponse> {
    const kind = kindOf(req);
    this.calls.push({ kind, req });
    const list = this.script[kind];
    if (!list?.length) throw new Error(`no scripted response for ${kind}`);
    const fn = list.length > 1 ? list.shift()! : list[0]!;
    return { data: fn(req), meta: {} };
  }
}

export function makeTestApp() {
  const dir = mkdtempSync(join(tmpdir(), 'zakir-t-'));
  const provider = new ScriptedProvider();
  /** Test clock: set clock.today to move between days. */
  const clock = { today: '2026-11-01' };
  const ctx = buildApp({ dataDir: dir, provider, today: () => clock.today });
  const cleanup = async () => {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const settle = async () => {
    await ctx.files.whenExtracted();
    await ctx.queue.idle();
  };
  async function upload(subjectId: number, kind: string, files: { name: string; data: Buffer }[]) {
    const form = new FormData();
    form.append('kind', kind);
    for (const f of files) form.append('file', new Blob([new Uint8Array(f.data)]), f.name);
    const req = new Request('http://x', { method: 'POST', body: form });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/subjects/${subjectId}/files`,
      headers: { 'content-type': req.headers.get('content-type')! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    return res.json().results as { fileId: number; ok: boolean }[];
  }
  async function json<T = any>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
    const res = await ctx.app.inject({ method: method as 'GET', url, payload: payload as object });
    return { status: res.statusCode, body: res.json() };
  }
  return { ...ctx, provider, clock, cleanup, settle, upload, json };
}
