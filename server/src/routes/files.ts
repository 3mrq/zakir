import type { FileKind } from '@zakir/shared';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.ts';
import { MAX_FILE_BYTES, UserError, type FileService } from '../ingest/service.ts';
import { idParam, parseBody } from './util.ts';

const kindSchema = z.enum(['content', 'past_exam'], { message: 'نوع الملف يجب أن يكون محتوى أو اختبارًا سابقًا' });

export function fileRoutes(app: FastifyInstance, db: DB, files: FileService) {
  const notFound = { error: 'الملف غير موجود.' };

  /**
   * Multipart upload: a "kind" field, then one or more files. Each file is stored and processed
   * independently; the response lists per-file results so one bad file does not block the rest.
   */
  app.post('/api/subjects/:id/files', async (req, reply) => {
    const subjectId = idParam(req);
    if (!db.prepare(`SELECT 1 FROM subjects WHERE id = ?`).get(subjectId)) return reply.status(404).send({ error: 'المادة غير موجودة.' });
    if (!req.isMultipart()) throw new UserError('أرسل الملفات بصيغة multipart/form-data.');

    let kind: FileKind = 'content';
    const results: { name: string; ok: boolean; duplicate?: boolean; fileId?: number; error?: string }[] = [];
    for await (const part of req.parts({ limits: { fileSize: MAX_FILE_BYTES } })) {
      if (part.type === 'field') {
        if (part.fieldname === 'kind') kind = kindSchema.parse(part.value);
        continue;
      }
      const name = part.filename || 'ملف';
      try {
        const data = await part.toBuffer();
        const { file, duplicate } = files.add({ subjectId, kind, name, data });
        results.push({ name, ok: true, duplicate, fileId: file.id });
      } catch (e) {
        const tooBig = (e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE';
        const msg = tooBig ? `الملف «${name}» أكبر من ${MAX_FILE_BYTES / 1024 / 1024} ميجابايت.` : e instanceof UserError ? e.message : 'تعذّر حفظ الملف.';
        results.push({ name, ok: false, error: msg });
      }
    }
    if (!results.length) throw new UserError('لم يُرسل أي ملف.');
    return { results };
  });

  app.get('/api/subjects/:id/files', async (req) => files.listBySubject(idParam(req)));

  app.get('/api/files/:id', async (req, reply) => files.get(idParam(req)) ?? reply.status(404).send(notFound));

  app.get('/api/files/:id/pages', async (req, reply) => {
    const id = idParam(req);
    return files.get(id) ? files.pages(id) : reply.status(404).send(notFound);
  });

  // Original file for the in-app viewer.
  app.get('/api/files/:id/raw', async (req, reply) => {
    const f = files.absPath(idParam(req));
    if (!f) return reply.status(404).send(notFound);
    reply.header('content-type', f.mime);
    reply.header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(createReadStream(f.path));
  });

  app.patch('/api/files/:id', async (req, reply) => {
    const id = idParam(req);
    if (!files.get(id)) return reply.status(404).send(notFound);
    const { kind } = parseBody(z.object({ kind: kindSchema }), req.body);
    files.setKind(id, kind);
    return files.get(id);
  });

  app.post('/api/files/:id/retry-ocr', async (req) => ({ queued: files.retryOcr(idParam(req)) }));

  app.delete('/api/files/:id', async (req) => {
    files.delete(idParam(req));
    return { ok: true };
  });
}
