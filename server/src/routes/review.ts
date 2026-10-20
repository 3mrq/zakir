import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import type { QuizService } from '../study/quiz.ts';
import type { ReviewService } from '../study/review.ts';
import { idParam } from './util.ts';

export function reviewRoutes(app: FastifyInstance, db: DB, review: ReviewService, quizzes: QuizService) {
  const subject = (req: Parameters<typeof idParam>[0]) => {
    const id = idParam(req);
    if (!db.prepare(`SELECT 1 FROM subjects WHERE id = ?`).get(id)) throw new UserError('المادة غير موجودة.', 404);
    return id;
  };

  app.get('/api/review/today', async () => review.summary());
  app.post('/api/subjects/:id/review', async (req) => quizzes.createReview(subject(req)));
  app.get('/api/subjects/:id/weaknesses', async (req) => review.weaknesses(subject(req)));
  app.get('/api/subjects/:id/mistakes', async (req) => review.mistakes(subject(req)));
}
