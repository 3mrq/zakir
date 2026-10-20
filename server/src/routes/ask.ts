import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import type { AskService } from '../study/ask.ts';
import { idParam, parseBody } from './util.ts';

const scopeSchema = z.object({
  chapterId: z.number().int().optional(),
  range: z.object({ fileId: z.number().int(), from: z.number().int(), to: z.number().int() }).optional(),
  label: z.string().max(200).optional(),
});

export function askRoutes(app: FastifyInstance, db: DB, ask: AskService) {
  const subject = (req: Parameters<typeof idParam>[0]) => {
    const id = idParam(req);
    if (!db.prepare(`SELECT 1 FROM subjects WHERE id = ?`).get(id)) throw new UserError('المادة غير موجودة.', 404);
    return id;
  };

  app.get('/api/settings', async () => ask.settings());
  app.put('/api/settings', async (req) => {
    ask.setSettings(parseBody(z.object({ dialect: z.enum(['fusha', 'saudi']) }), req.body));
    return ask.settings();
  });

  app.get('/api/subjects/:id/ask-threads', async (req) => ask.threads(subject(req)));
  app.post('/api/subjects/:id/ask', async (req) => {
    const body = parseBody(
      z.object({ threadId: z.number().int().optional(), question: z.string().max(2000, 'السؤال أطول من 2000 حرف'), scope: scopeSchema.default({}) }),
      req.body,
    );
    return ask.ask(subject(req), body);
  });
  app.get('/api/ask-threads/:id', async (req, reply) => ask.thread(idParam(req)) ?? reply.status(404).send({ error: 'المحادثة غير موجودة.' }));
  app.delete('/api/ask-threads/:id', async (req) => {
    ask.deleteThread(idParam(req));
    return { ok: true };
  });
  app.post('/api/asks/:id/retry', async (req) => ask.retry(idParam(req)));
}
