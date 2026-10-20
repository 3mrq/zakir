// The doctor's style profile, built from a subject's past-exam files.

import type { Confidence, JobDTO, StyleProfile, StyleProfileDTO } from '@zakir/shared';
import type { JobQueue } from '../ai/queue.ts';
import { toPageRef } from '../ai/task.ts';
import { makeAnalyzeStyleTask, MAX_STYLE_CHARS, type AnalyzeStyleInput, type AnalyzeStyleOutput } from '../ai/tasks/analyzeStyle.ts';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import type { ChapterService } from './chapters.ts';

/** Confidence from how much evidence the profile rests on. */
export function confidenceFor(exams: number, questions: number): { level: Confidence; reason: string } {
  const base = `مبني على ${exams} اختبار و${questions} سؤالًا.`;
  if (exams >= 4 && questions >= 40) return { level: 'high', reason: `${base} كمية كافية لتمثيل أسلوبه بشكل جيد.` };
  if (exams >= 2 && questions >= 15)
    return { level: 'medium', reason: `${base} يعطي صورة معقولة، لكن النسب قد تتغير مع اختبارات أكثر.` };
  return { level: 'low', reason: `${base} قليل لاستنتاج نمط ثابت — اعتبر النسب مؤشرًا أوليًا، وأضف اختبارات أكثر لرفع الثقة.` };
}

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

export class StyleService {
  private readonly task;

  constructor(
    private readonly db: DB,
    private readonly queue: JobQueue,
    private readonly chapters: ChapterService,
  ) {
    this.task = makeAnalyzeStyleTask({ onSuccess: (out, input) => this.save(out, input) });
  }

  private examFiles(subjectId: number) {
    return this.db
      .prepare(`SELECT id, name, status FROM files WHERE subject_id = ? AND kind = 'past_exam' ORDER BY id`)
      .all(subjectId) as { id: number; name: string; status: string }[];
  }

  start(subjectId: number): JobDTO {
    const ref = { type: 'subject', id: subjectId };
    const running = this.queue.activeFor('analyze_style', ref);
    if (running) return running;
    const files = this.examFiles(subjectId);
    if (!files.length) throw new UserError('ارفع اختبارات سابقة أولًا (اختر «اختبار سابق» عند الرفع).');
    const busy = files.filter((f) => f.status === 'processing' || f.status === 'ocr');
    if (busy.length) throw new UserError(`انتظر حتى تنتهي معالجة: ${busy.map((f) => `«${f.name}»`).join('، ')}.`);
    const pages = (
      this.db
        .prepare(`SELECT file_id fileId, page_no page, text FROM pages WHERE file_id IN (${files.map(() => '?').join(',')}) AND text != '' ORDER BY file_id, page_no`)
        .all(...files.map((f) => f.id)) as { fileId: number; page: number; text: string }[]
    );
    if (!pages.length) throw new UserError('لا يوجد نص مقروء في ملفات الاختبارات السابقة.');
    if (pages.reduce((n, p) => n + p.text.length, 0) > MAX_STYLE_CHARS) {
      throw new UserError('نصوص الاختبارات السابقة أكبر من أن تُحلل دفعة واحدة. احذف بعض الملفات الأقل أهمية ثم أعد المحاولة.');
    }
    const chapters = this.chapters.list(subjectId).map((c) => ({ id: c.id, title: c.title, topics: c.topics.map((t) => t.title) }));
    const input: AnalyzeStyleInput = { subjectId, fileIds: files.map((f) => f.id), pages, chapters };
    return this.queue.enqueue(this.task, input, ref);
  }

  private save(out: AnalyzeStyleOutput, input: AnalyzeStyleInput) {
    const total = out.totalQuestions;
    const profile: StyleProfile = {
      examsDetected: out.examsDetected,
      totalQuestions: total,
      language: out.language,
      structure: out.structure,
      types: out.types.filter((t) => t.count > 0).sort((a, b) => b.count - a.count).map((t) => ({ ...t, percent: pct(t.count, total) })),
      chapters: out.chapters
        .filter((c) => c.count > 0)
        .sort((a, b) => b.count - a.count)
        .map((c) => {
          const ch = c.chapter === 'none' ? undefined : input.chapters[Number(c.chapter.slice(1)) - 1];
          return { chapterId: ch?.id ?? null, title: ch?.title ?? 'غير مرتبط بشابتر', count: c.count, percent: pct(c.count, total) };
        }),
      recurringTopics: out.recurringTopics.map((t) => ({ topic: t.topic, count: t.count, refs: t.refs.map(toPageRef) })),
      phrasing: out.phrasing,
      examples: out.examples.map((e) => ({ type: e.type, text: e.text, refs: e.refs.map(toPageRef) })),
    };
    this.db
      .prepare(`INSERT INTO style_profiles (subject_id, file_ids_json, profile_json) VALUES (?, ?, ?)`)
      .run(input.subjectId, JSON.stringify(input.fileIds), JSON.stringify(profile));
  }

  latest(subjectId: number): StyleProfileDTO | undefined {
    const r = this.db.prepare(`SELECT * FROM style_profiles WHERE subject_id = ? ORDER BY id DESC LIMIT 1`).get(subjectId) as
      | { id: number; subject_id: number; file_ids_json: string; profile_json: string; created_at: string }
      | undefined;
    if (!r) return undefined;
    const profile = JSON.parse(r.profile_json) as StyleProfile;
    const fileIds = JSON.parse(r.file_ids_json) as number[];
    const current = this.examFiles(subjectId);
    const names = new Map(current.map((f) => [f.id, f.name]));
    const { level, reason } = confidenceFor(profile.examsDetected, profile.totalQuestions);
    return {
      id: r.id,
      subjectId,
      files: fileIds.map((id) => ({ id, name: names.get(id) ?? 'ملف محذوف' })),
      confidence: level,
      confidenceReason: reason,
      outdated: current.map((f) => f.id).join(',') !== fileIds.join(','),
      profile,
      createdAt: r.created_at,
    };
  }
}
