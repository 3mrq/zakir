import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import type { PlanService } from '../study/plan.ts';
import { idParam, parseBody } from './util.ts';

export function planRoutes(app: FastifyInstance, db: DB, plans: PlanService) {
  app.get('/api/exams/:id/plan', async (req) => {
    const id = idParam(req);
    return { settings: plans.settings(id), plan: plans.get(id) };
  });

  app.put('/api/exams/:id/plan', async (req) => {
    const id = idParam(req);
    const body = parseBody(
      z.object({
        dailyMinutes: z.number({ message: 'الوقت اليومي مطلوب' }).int(),
        offDays: z.array(z.number().int()).default([]),
        minutesPerPage: z.number().default(4),
      }),
      req.body,
    );
    plans.save(id, body);
    return { settings: plans.settings(id), plan: plans.get(id) };
  });

  app.delete('/api/exams/:id/plan', async (req) => {
    plans.remove(idParam(req));
    return { ok: true };
  });

  app.post('/api/exams/:id/plan/tasks', async (req) => {
    const id = idParam(req);
    const { key, status } = parseBody(z.object({ key: z.string().max(100), status: z.enum(['pending', 'done', 'skipped']) }), req.body);
    plans.setTask(id, key, status);
    return plans.get(id);
  });

  app.get('/api/plans/today', async () => plans.todayTasks());

  // Editing an exam (title / date) — the plan follows the new date on its next read.
  app.patch('/api/exams/:id', async (req) => {
    const id = idParam(req);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(1, 'اسم الاختبار مطلوب').max(200).optional(),
        examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة سنة-شهر-يوم').nullable().optional(),
      }),
      req.body,
    );
    const { changes } = db
      .prepare(`UPDATE exams SET title = COALESCE(?, title), exam_date = CASE WHEN ? THEN ? ELSE exam_date END WHERE id = ?`)
      .run(body.title ?? null, body.examDate !== undefined ? 1 : 0, body.examDate ?? null, id);
    if (!changes) throw new UserError('الاختبار غير موجود.', 404);
    return { ok: true };
  });
}
