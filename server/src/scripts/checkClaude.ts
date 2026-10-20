// npm run check:claude — verifies install, login, and one real cited call through the queue.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeProvider } from '../ai/claudeCode.ts';
import { JobQueue } from '../ai/queue.ts';
import { smokeTestTask } from '../ai/tasks/smokeTest.ts';
import { config } from '../config.ts';
import { openDb } from '../db/index.ts';

const provider = new ClaudeCodeProvider(config.claudeBin);
const health = await provider.healthCheck();
console.log(`[1] الفحص: ${health.message}`);
if (health.bin) console.log(`    المسار: ${health.bin}`);
if (health.code !== 'ok') {
  if (health.fix) console.log(`    الحل: ${health.fix}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'zakir-check-'));
const db = openDb(join(tmp, 'check.db'));
const queue = new JobQueue(db, provider, {
  concurrency: 2,
  model: config.aiModel,
  promptsDir: config.promptsDir,
  workRoot: join(tmp, 'work'),
});

const questions = ['أين يتم إنتاج ATP؟', 'ما وظيفة الرايبوسوم (Ribosome)؟'];
console.log(`[2] إرسال سؤالين بالتوازي (النموذج: ${config.aiModel})...`);
const jobs = questions.map((question) => queue.enqueue(smokeTestTask, { question }));
await queue.idle();

let ok = true;
for (const [i, j] of jobs.entries()) {
  const job = queue.get(j.id)!;
  console.log(`\n    س: ${questions[i]}`);
  console.log(`    الحالة: ${job.status} — المحاولات: ${job.attempts} — المدة: ${job.durationMs} ms`);
  if (job.status === 'done') console.log(`    النتيجة: ${JSON.stringify(job.result)}`);
  else {
    ok = false;
    console.log(`    الخطأ: ${job.error}`);
  }
}
db.close();
rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
