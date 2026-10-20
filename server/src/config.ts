import { config as loadEnv } from 'dotenv';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: join(ROOT, '.env'), quiet: true });

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export const config = {
  host: '127.0.0.1',
  port: int(process.env.PORT, 8787),
  dataDir: process.env.DATA_DIR?.trim() || join(ROOT, 'data'),
  promptsDir: join(ROOT, 'prompts'),
  claudeBin: process.env.CLAUDE_BIN?.trim() || undefined,
  aiModel: process.env.AI_MODEL?.trim() || 'sonnet',
  aiConcurrency: Math.min(2, Math.max(1, int(process.env.AI_CONCURRENCY, 2))),
};
