// Study plan per exam: gathers current state from the database and runs the pure planner.

import type { PlanDTO, PlanSettings, TodayTaskDTO } from '@zakir/shared';
import type { DB } from '../db/index.ts';
import { UserError } from '../ingest/service.ts';
import type { ChapterService } from './chapters.ts';
import { buildPlan, type PlanChapter, type TaskState } from './planner.ts';
import type { ReviewService } from './review.ts';
import type { StyleService } from './style.ts';

interface ExamRow {
  id: number;
  subject_id: number;
  title: string;
  exam_date: string | null;
}

export class PlanService {
  constructor(
    private readonly db: DB,
    private readonly chapters: ChapterService,
    private readonly style: StyleService,
    private readonly review: ReviewService,
    private readonly today: () => string,
  ) {}

  private exam(id: number): ExamRow {
    const e = this.db.prepare(`SELECT id, subject_id, title, exam_date FROM exams WHERE id = ?`).get(id) as ExamRow | undefined;
    if (!e) throw new UserError('الاختبار غير موجود.', 404);
    return e;
  }

  settings(examId: number): (PlanSettings & { createdAt: string }) | null {
    const r = this.db.prepare(`SELECT * FROM exam_plans WHERE exam_id = ?`).get(examId) as
      | { daily_minutes: number; off_days_json: string; minutes_per_page: number; created_at: string }
      | undefined;
    return r ? { dailyMinutes: r.daily_minutes, offDays: JSON.parse(r.off_days_json), minutesPerPage: r.minutes_per_page, createdAt: r.created_at } : null;
  }

  save(examId: number, s: PlanSettings) {
    this.exam(examId);
    if (!Number.isInteger(s.dailyMinutes) || s.dailyMinutes < 15 || s.dailyMinutes > 900) throw new UserError('الوقت اليومي من 15 دقيقة إلى 15 ساعة.');
    const offDays = [...new Set(s.offDays)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (offDays.length === 7) throw new UserError('لا يمكن أن تكون كل أيام الأسبوع راحة.');
    if (!(s.minutesPerPage >= 1 && s.minutesPerPage <= 20)) throw new UserError('سرعة المذاكرة من 1 إلى 20 دقيقة للصفحة.');
    this.db
      .prepare(
        `INSERT INTO exam_plans (exam_id, daily_minutes, off_days_json, minutes_per_page) VALUES (?, ?, ?, ?)
         ON CONFLICT(exam_id) DO UPDATE SET daily_minutes = excluded.daily_minutes, off_days_json = excluded.off_days_json,
           minutes_per_page = excluded.minutes_per_page, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(examId, s.dailyMinutes, JSON.stringify(offDays), s.minutesPerPage);
  }

  remove(examId: number) {
    this.db.prepare(`DELETE FROM exam_plans WHERE exam_id = ?`).run(examId);
    this.db.prepare(`DELETE FROM plan_task_state WHERE exam_id = ?`).run(examId);
  }

  setTask(examId: number, key: string, status: 'pending' | 'done' | 'skipped') {
    this.exam(examId);
    if (!/^(study:\d+:\d+|practice:\d+|strengthen:\d+|mock|final)$/.test(key)) throw new UserError('مهمة غير معروفة.');
    this.db
      .prepare(
        `INSERT INTO plan_task_state (exam_id, task_key, status, done_on, auto) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(exam_id, task_key) DO UPDATE SET status = excluded.status, done_on = excluded.done_on, auto = 0`,
      )
      .run(examId, key, status, status === 'pending' ? null : this.today());
  }

  get(examId: number): PlanDTO | null {
    const exam = this.exam(examId);
    const settings = this.settings(examId);
    if (!settings) return null;
    if (!exam.exam_date) throw new UserError('حدّد تاريخ الاختبار أولًا لإنشاء خطة له.');

    // Scope: the exam's chapters, or all chapters if none chosen.
    const all = this.chapters.list(exam.subject_id);
    if (!all.length) throw new UserError('قسّم المادة إلى شباترات أولًا — الخطة مبنية على الشباترات.');
    const scopeIds = new Set((this.db.prepare(`SELECT chapter_id FROM exam_scope WHERE exam_id = ?`).all(examId) as { chapter_id: number }[]).map((r) => r.chapter_id));
    const scope = scopeIds.size ? all.filter((c) => scopeIds.has(c.id)) : all;

    const profile = this.style.latest(exam.subject_id)?.profile;
    const weak = this.review.weaknesses(exam.subject_id);
    const since = settings.createdAt;
    const practice = this.db.prepare(
      `SELECT COUNT(*) n FROM attempts a JOIN questions q ON q.id = a.question_id WHERE q.chapter_id = ? AND a.status = 'graded' AND a.created_at >= ?`,
    );
    const chapters: PlanChapter[] = scope.map((c) => {
      const w = weak.chapters.find((x) => x.chapterId === c.id);
      const styleRow = profile?.chapters.find((x) => x.chapterId === c.id);
      return {
        id: c.id,
        title: c.title,
        pageCount: c.pageCount,
        ranges: c.ranges,
        topics: c.topics,
        hasSummary: c.summary !== 'none',
        weight: profile ? (styleRow?.percent ?? 0) / 100 : null,
        accuracy: w && w.attempts >= weak.minAttempts ? w.accuracy : null,
        weakTopics: weak.topics.filter((t) => t.chapterId === c.id && t.attempts >= weak.minAttempts && t.accuracy < 0.6).map((t) => t.title),
        practiceAnswers: (practice.get(c.id, since) as { n: number }).n,
      };
    });

    const state = new Map<string, TaskState>(
      (
        this.db.prepare(`SELECT task_key, status, first_planned_on, done_on, auto FROM plan_task_state WHERE exam_id = ?`).all(examId) as {
          task_key: string;
          status: TaskState['status'];
          first_planned_on: string | null;
          done_on: string | null;
          auto: number;
        }[]
      ).map((r) => [r.task_key, { status: r.status, firstPlannedOn: r.first_planned_on, doneOn: r.done_on, auto: !!r.auto }]),
    );
    const summary = this.review.summary().find((s) => s.subjectId === exam.subject_id);
    const today = this.today();
    const result = buildPlan({ today, examDate: exam.exam_date, settings, chapters, dueCards: summary?.due ?? 0, learningCards: summary?.learning ?? 0, state });

    // Persist what the computation learned: automatic completions and first scheduled days.
    this.db.transaction(() => {
      const up = this.db.prepare(
        `INSERT INTO plan_task_state (exam_id, task_key, status, first_planned_on, done_on, auto) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(exam_id, task_key) DO UPDATE SET status = excluded.status, done_on = excluded.done_on, auto = excluded.auto`,
      );
      for (const key of result.autoDone) up.run(examId, key, 'done', state.get(key)?.firstPlannedOn ?? null, today, 1);
      const first = this.db.prepare(
        `INSERT INTO plan_task_state (exam_id, task_key, status, first_planned_on) VALUES (?, ?, 'pending', ?)
         ON CONFLICT(exam_id, task_key) DO UPDATE SET first_planned_on = COALESCE(first_planned_on, excluded.first_planned_on)`,
      );
      for (const [key, day] of result.firstPlanned) first.run(examId, key, day);
    })();

    const warnings = [...result.warnings];
    if (!scopeIds.size) warnings.unshift('لم تحدّد نطاق هذا الاختبار، فالخطة تشمل كل الشباترات. حدّد النطاق من بطاقة «الاختبارات» في صفحة المادة.');
    if (!profile) warnings.push('لا يوجد تحليل لاختبارات الدكتور السابقة، فكل الشباترات بنفس الأهمية. حلّلها من «التدريب والأسئلة» لترتيب أدق.');

    return {
      examId,
      examTitle: exam.title,
      examDate: exam.exam_date,
      subjectId: exam.subject_id,
      settings: { dailyMinutes: settings.dailyMinutes, offDays: settings.offDays, minutesPerPage: settings.minutesPerPage },
      scope: chapters.map((c) => ({ chapterId: c.id, title: c.title, weight: c.weight ?? 0, accuracy: c.accuracy })),
      days: result.days,
      overflow: result.overflow,
      history: result.history,
      stats: result.stats,
      warnings,
    };
  }

  /** Today's tasks across every exam that has a plan. */
  todayTasks(): TodayTaskDTO[] {
    const rows = this.db
      .prepare(
        `SELECT p.exam_id, e.title, e.exam_date, s.id subject_id, s.name FROM exam_plans p JOIN exams e ON e.id = p.exam_id JOIN subjects s ON s.id = e.subject_id
         WHERE e.exam_date IS NOT NULL AND e.exam_date > ? ORDER BY e.exam_date`,
      )
      .all(this.today()) as { exam_id: number; title: string; subject_id: number; name: string }[];
    const out: TodayTaskDTO[] = [];
    for (const r of rows) {
      let plan: PlanDTO | null = null;
      try {
        plan = this.get(r.exam_id);
      } catch {
        continue; // e.g. chapters were removed; the plan page explains it
      }
      const day = plan?.days.find((d) => d.date === this.today());
      for (const t of day?.tasks ?? []) out.push({ ...t, examId: r.exam_id, examTitle: r.title, subjectId: r.subject_id, subjectName: r.name });
    }
    return out;
  }
}
