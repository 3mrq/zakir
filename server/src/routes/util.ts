import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { UserError } from '../ingest/service.ts';

/** Validates a JSON body; throws a UserError carrying the first Arabic message. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new UserError(r.error.issues[0]?.message ?? 'بيانات غير صالحة.');
  return r.data;
}

export function idParam(req: FastifyRequest, name = 'id'): number {
  const v = Number((req.params as Record<string, string>)[name]);
  if (!Number.isInteger(v) || v <= 0) throw new UserError('رقم غير صالح.');
  return v;
}
