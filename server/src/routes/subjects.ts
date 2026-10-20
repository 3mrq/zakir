import type { ExamDTO, SubjectDTO } from '@zakir/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.ts';
import type { FileService } from '../ingest/service.ts';
import { idParam, parseBody } from './util.ts';

const subjectBody = z.object({
  name: z.string().trim().min(1, 'اسم المادة مطلوب').max(200),
  doctor: z.string().trim().max(200).optional().transform((v) => v || null),
});

const examBody = z.object({
  title: z.string().trim().min(1, 'اسم الاختبار مطلوب').max(200),
  examDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة سنة-شهر-يوم')
    .nullish()
    .transform((v) => v ?? null),
});

export function subjectRoutes(app: FastifyInstance, db: DB, files: FileService) {
  const exams = (subjectId: number) =>
    (db.prepare(`SELECT id, subject_id, title, exam_date FROM exams WHERE subject_id = ? ORDER BY exam_date IS NULL, exam_date, id`).all(subjectId) as {
      id: number;
      subject_id: number;
      title: string;
      exam_date: string | null;
    }[]).map(
      (e): ExamDTO => ({
        id: e.id,
        subjectId: e.subject_id,
        title: e.title,
        examDate: e.exam_date,
        chapterIds: (db.prepare(`SELECT chapter_id FROM exam_scope WHERE exam_id = ?`).all(e.id) as { chapter_id: number }[]).map((r) => r.chapter_id),
      }),
    );

  const subject = (id: number): SubjectDTO | undefined => {
    const r = db
      .prepare(`SELECT s.*, (SELECT COUNT(*) FROM files f WHERE f.subject_id = s.id) file_count FROM subjects s WHERE s.id = ?`)
      .get(id) as { id: number; name: string; doctor: string | null; created_at: string; file_count: number } | undefined;
    return r && { id: r.id, name: r.name, doctor: r.doctor, createdAt: r.created_at, fileCount: r.file_count, exams: exams(r.id) };
  };

  const notFound = { error: 'المادة غير موجودة.' };

  app.get('/api/subjects', async () =>
    (db.prepare(`SELECT id FROM subjects ORDER BY id DESC`).all() as { id: number }[]).map((r) => subject(r.id)!),
  );

  app.post('/api/subjects', async (req, reply) => {
    const body = parseBody(subjectBody, req.body);
    const { lastInsertRowid } = db.prepare(`INSERT INTO subjects (name, doctor) VALUES (?, ?)`).run(body.name, body.doctor);
    return reply.status(201).send(subject(Number(lastInsertRowid)));
  });

  app.get('/api/subjects/:id', async (req, reply) => subject(idParam(req)) ?? reply.status(404).send(notFound));

  app.patch('/api/subjects/:id', async (req, reply) => {
    const id = idParam(req);
    const body = parseBody(subjectBody, req.body);
    const { changes } = db.prepare(`UPDATE subjects SET name = ?, doctor = ? WHERE id = ?`).run(body.name, body.doctor, id);
    return changes ? subject(id) : reply.status(404).send(notFound);
  });

  app.delete('/api/subjects/:id', async (req) => {
    const id = idParam(req);
    files.deleteSubjectFiles(id);
    db.prepare(`DELETE FROM subjects WHERE id = ?`).run(id);
    return { ok: true };
  });

  app.post('/api/subjects/:id/exams', async (req, reply) => {
    const id = idParam(req);
    if (!subject(id)) return reply.status(404).send(notFound);
    const body = parseBody(examBody, req.body);
    db.prepare(`INSERT INTO exams (subject_id, title, exam_date) VALUES (?, ?, ?)`).run(id, body.title, body.examDate);
    return reply.status(201).send(subject(id));
  });

  app.delete('/api/exams/:id', async (req) => {
    db.prepare(`DELETE FROM exams WHERE id = ?`).run(idParam(req));
    return { ok: true };
  });
}
