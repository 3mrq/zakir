import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import type { QuestionService } from '../study/questions.ts';
import type { QuizService } from '../study/quiz.ts';
import type { StyleService } from '../study/style.ts';
import { idParam, parseBody } from './util.ts';

const qtype = z.enum(['mcq', 'true_false', 'short_answer', 'essay']);

export function studyRoutes(app: FastifyInstance, db: DB, style: StyleService, questions: QuestionService, quizzes: QuizService) {
  const subject = (req: Parameters<typeof idParam>[0]) => {
    const id = idParam(req);
    if (!db.prepare(`SELECT 1 FROM subjects WHERE id = ?`).get(id)) throw new UserError('المادة غير موجودة.', 404);
    return id;
  };

  // ---------- style ----------
  app.get('/api/subjects/:id/style', async (req) => ({ style: style.latest(subject(req)) ?? null }));
  app.post('/api/subjects/:id/style/analyze', async (req) => style.start(subject(req)));

  // ---------- question sets & bank ----------
  app.get('/api/subjects/:id/question-sets', async (req) => questions.listSets(subject(req)));
  app.post('/api/subjects/:id/question-sets', async (req) => {
    const body = parseBody(
      z.object({
        chapterIds: z.array(z.number().int()).min(1, 'اختر شابترًا واحدًا على الأقل'),
        type: z.union([qtype, z.literal('mixed')]),
        difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']),
        count: z.number().int(),
      }),
      req.body,
    );
    return questions.generate(subject(req), body);
  });
  app.post('/api/question-sets/:id/verify', async (req) => {
    questions.retryVerify(idParam(req));
    return { ok: true };
  });
  app.get('/api/subjects/:id/questions', async (req) => {
    const q = parseBody(z.object({ setId: z.coerce.number().int().optional() }), req.query);
    return questions.list(subject(req), q.setId);
  });
  app.post('/api/questions/:id/report', async (req) => {
    const { note } = parseBody(z.object({ note: z.string().trim().min(3, 'اكتب ما الخطأ في السؤال (3 أحرف على الأقل)').max(1000) }), req.body);
    questions.report(idParam(req), note);
    return { ok: true };
  });
  app.post('/api/questions/:id/restore', async (req) => {
    questions.restore(idParam(req));
    return { ok: true };
  });

  // ---------- quizzes ----------
  app.get('/api/subjects/:id/quizzes', async (req) => quizzes.list(subject(req)));
  app.post('/api/subjects/:id/quizzes', async (req) => {
    const body = parseBody(
      z.object({
        setId: z.number().int().optional(),
        chapterIds: z.array(z.number().int()).optional(),
        types: z.array(qtype).optional(),
        count: z.number().int().optional(),
        timeLimitMin: z.number().nullable().optional(),
      }),
      req.body,
    );
    return quizzes.create(subject(req), body);
  });
  app.get('/api/quizzes/:id', async (req, reply) => quizzes.get(idParam(req)) ?? reply.status(404).send({ error: 'الاختبار غير موجود.' }));
  app.post('/api/quizzes/:id/answer', async (req) => {
    const body = parseBody(
      z.object({ questionId: z.number().int(), choice: z.number().int().optional(), bool: z.boolean().optional(), text: z.string().optional() }),
      req.body,
    );
    const { questionId, ...answer } = body;
    return quizzes.answer(idParam(req), questionId, answer);
  });
  app.post('/api/quizzes/:id/regrade', async (req) => {
    const { questionId } = parseBody(z.object({ questionId: z.number().int() }), req.body);
    return quizzes.retryGrade(idParam(req), questionId);
  });
  app.post('/api/quizzes/:id/finish', async (req) => quizzes.finish(idParam(req)));
}
