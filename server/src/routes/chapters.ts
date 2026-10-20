import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.ts';
import type { ChapterService } from '../study/chapters.ts';
import { idParam, parseBody } from './util.ts';

const int = z.number({ message: 'رقم الصفحة مطلوب' }).int('رقم الصفحة يجب أن يكون عددًا صحيحًا');
const range = z.object({ fileId: z.number().int(), from: int, to: int });
const chaptersBody = z.object({
  chapters: z.array(
    z.object({
      id: z.number().int().optional(),
      title: z.string().max(300),
      ranges: z.array(range),
      topics: z.array(range.extend({ title: z.string().max(300) })),
    }),
  ),
});

export function chapterRoutes(app: FastifyInstance, db: DB, chapters: ChapterService) {
  const subjectExists = (id: number) => !!db.prepare(`SELECT 1 FROM subjects WHERE id = ?`).get(id);
  const notFound = { error: 'الشابتر غير موجود.' };

  app.get('/api/subjects/:id/chapters', async (req, reply) => {
    const id = idParam(req);
    if (!subjectExists(id)) return reply.status(404).send({ error: 'المادة غير موجودة.' });
    return { chapters: chapters.list(id), files: chapters.contentFiles(id) };
  });

  app.put('/api/subjects/:id/chapters', async (req, reply) => {
    const id = idParam(req);
    if (!subjectExists(id)) return reply.status(404).send({ error: 'المادة غير موجودة.' });
    chapters.replaceAll(id, parseBody(chaptersBody, req.body).chapters);
    return { chapters: chapters.list(id), files: chapters.contentFiles(id) };
  });

  app.post('/api/subjects/:id/chapters/auto', async (req) => chapters.startSegmentation(idParam(req)));

  app.get('/api/chapters/:id', async (req, reply) => {
    const id = idParam(req);
    const chapter = chapters.get(id);
    if (!chapter) return reply.status(404).send(notFound);
    return { chapter, summary: chapters.summary(id) ?? null, files: chapters.contentFiles(chapter.subjectId) };
  });

  app.post('/api/chapters/:id/summarize', async (req) => chapters.startSummary(idParam(req)));

  app.put('/api/exams/:id/scope', async (req) => {
    const { chapterIds } = parseBody(z.object({ chapterIds: z.array(z.number().int()) }), req.body);
    chapters.setExamScope(idParam(req), chapterIds);
    return { ok: true };
  });
}
