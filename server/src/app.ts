import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { join } from 'node:path';
import { z } from 'zod';
import { ClaudeCodeProvider } from './ai/claudeCode.ts';
import type { AIProvider } from './ai/provider.ts';
import { JobQueue } from './ai/queue.ts';
import { smokeTestTask } from './ai/tasks/smokeTest.ts';
import { config } from './config.ts';
import { openDb } from './db/index.ts';
import { FileService, MAX_FILE_BYTES, UserError } from './ingest/service.ts';
import { askRoutes } from './routes/ask.ts';
import { chapterRoutes } from './routes/chapters.ts';
import { fileRoutes } from './routes/files.ts';
import { planRoutes } from './routes/plan.ts';
import { reviewRoutes } from './routes/review.ts';
import { studyRoutes } from './routes/study.ts';
import { AskService } from './study/ask.ts';
import { ChapterService } from './study/chapters.ts';
import { QuestionService } from './study/questions.ts';
import { QuizService } from './study/quiz.ts';
import { PlanService } from './study/plan.ts';
import { localToday, ReviewService } from './study/review.ts';
import { StyleService } from './study/style.ts';
import { subjectRoutes } from './routes/subjects.ts';
import { idParam, parseBody } from './routes/util.ts';

export function buildApp(opts: { dataDir?: string; provider?: AIProvider; today?: () => string } = {}) {
  const dataDir = opts.dataDir ?? config.dataDir;
  const db = openDb(join(dataDir, 'app.db'));
  const provider = opts.provider ?? new ClaudeCodeProvider(config.claudeBin);
  const queue = new JobQueue(db, provider, {
    concurrency: config.aiConcurrency,
    model: config.aiModel,
    promptsDir: config.promptsDir,
    workRoot: join(dataDir, 'work'),
  });
  const files = new FileService(db, queue, join(dataDir, 'uploads'));
  files.resume();
  const chapters = new ChapterService(db, queue);
  const style = new StyleService(db, queue, chapters);
  const questions = new QuestionService(db, queue, chapters, style);
  const today = opts.today ?? (() => localToday());
  const review = new ReviewService(db, today);
  const quizzes = new QuizService(db, queue, review);
  const ask = new AskService(db, queue, chapters);
  const plans = new PlanService(db, chapters, style, review, today);

  const app = Fastify({ logger: { level: 'warn' } });
  app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 50 } });

  // Arabic error body; UserError messages are shown as-is, anything else is generic.
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof UserError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: err.issues[0]?.message ?? 'بيانات غير صالحة.' });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) app.log.error(err);
    reply.status(status).send({ error: status === 500 ? 'حدث خطأ غير متوقع في الخادم.' : 'الطلب غير صالح.', detail: err.message });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/ai/health', async () => provider.healthCheck());

  app.get('/api/jobs', async (req) => {
    const q = parseBody(z.object({ refType: z.string().optional(), refId: z.coerce.number().int().optional() }), req.query);
    return queue.list(50, q.refType && q.refId ? { type: q.refType, id: q.refId } : undefined);
  });
  app.get('/api/jobs/:id', async (req, reply) => queue.get(idParam(req)) ?? reply.status(404).send({ error: 'المهمة غير موجودة.' }));
  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const ok = queue.cancel(idParam(req));
    return ok ? { ok } : reply.status(409).send({ error: 'لا يمكن إلغاء المهمة: انتهت أو غير موجودة.' });
  });
  app.post('/api/jobs/smoke-test', async (req) => {
    const body = parseBody(z.object({ question: z.string().trim().min(1, 'اكتب سؤالًا').max(500, 'السؤال أطول من 500 حرف') }), req.body);
    return queue.enqueue(smokeTestTask, body);
  });

  subjectRoutes(app, db, files);
  fileRoutes(app, db, files);
  chapterRoutes(app, db, chapters);
  studyRoutes(app, db, style, questions, quizzes);
  askRoutes(app, db, ask);
  reviewRoutes(app, db, review, quizzes);
  planRoutes(app, db, plans);

  app.addHook('onClose', async () => db.close());
  return { app, queue, db, provider, files, chapters, style, questions, quizzes, ask, review, plans };
}
