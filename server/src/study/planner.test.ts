import type { PlanDayDTO } from '@zakir/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixture, makeTestApp } from '../../test/helpers.ts';
import { buildPlan, type PlanChapter, type PlanInput, type TaskState } from './planner.ts';
import { addDays } from './review.ts';

const TODAY = '2026-11-01'; // a Sunday
const chapter = (id: number, pages: number, extra: Partial<PlanChapter> = {}): PlanChapter => ({
  id,
  title: `Ch${id}`,
  pageCount: pages,
  topics: [],
  ranges: [{ fileId: 1, from: id * 100, to: id * 100 + pages - 1 }],
  hasSummary: true,
  weight: null,
  accuracy: null,
  weakTopics: [],
  practiceAnswers: 0,
  ...extra,
});
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  today: TODAY,
  examDate: '2026-11-08',
  settings: { dailyMinutes: 90, offDays: [], minutesPerPage: 4 },
  chapters: [chapter(1, 10), chapter(2, 10)],
  dueCards: 0,
  learningCards: 0,
  state: new Map(),
  ...over,
});
const keys = (d: PlanDayDTO) => d.tasks.map((t) => t.key);
const used = (d: PlanDayDTO) => d.tasks.reduce((n, t) => n + (t.kind === 'review' ? 0 : t.minutes), 0) + d.reserved;

describe('buildPlan', () => {
  it('schedules study → practice per chapter in order, closing with a mock exam and a final review, within capacity', () => {
    const p = buildPlan(input());
    expect(p.days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    const order = p.days.flatMap(keys);
    expect(order).toEqual(['study:1:1', 'practice:1', 'study:2:1', 'practice:2', 'mock', 'final']);
    // 90 min/day minus a 10-min review reserve: the 60-min mock goes the day before the final review.
    expect(keys(p.days.at(-1)!)).toEqual(['final']);
    expect(keys(p.days.at(-2)!)).toEqual(['mock']);
    for (const d of p.days) expect(used(d)).toBeLessThanOrEqual(d.capacity);
    expect(p.overflow).toEqual([]);
    expect(p.stats).toMatchObject({ totalMinutes: 40 + 20 + 40 + 20 + 60 + 30, doneMinutes: 0, daysLeft: 7, availableMinutes: 630 });
  });

  it('spreads the work over the days instead of front-loading the first day', () => {
    const p = buildPlan(input({ settings: { dailyMinutes: 180, offDays: [], minutesPerPage: 4 } }));
    const busy = p.days.filter((d) => d.tasks.some((t) => t.kind === 'study' || t.kind === 'practice'));
    expect(busy.length).toBeGreaterThan(1);
    expect(keys(p.days[0]!)).toEqual(['study:1:1']); // ~30 min/day target, not all 120 min on day 1
  });

  it('leaves off-days empty and keeps a review reserve on study days', () => {
    const p = buildPlan(input({ settings: { dailyMinutes: 60, offDays: [5], minutesPerPage: 4 } })); // Friday off
    const friday = p.days.find((d) => d.date === '2026-11-06')!;
    expect(friday).toMatchObject({ capacity: 0, tasks: [] });
    expect(p.days[1]!.reserved).toBe(10);
  });

  it('splits long chapters into parts by topic, each fitting a day', () => {
    const ch = chapter(1, 40, {
      topics: [
        { title: 'A', fileId: 1, from: 100, to: 109 },
        { title: 'B', fileId: 1, from: 110, to: 124 },
        { title: 'C', fileId: 1, from: 125, to: 139 },
      ],
    });
    const p = buildPlan(input({ chapters: [ch], settings: { dailyMinutes: 60, offDays: [], minutesPerPage: 4 }, examDate: '2026-11-15' }));
    const study = p.days.flatMap((d) => d.tasks).filter((t) => t.kind === 'study');
    expect(study.length).toBeGreaterThan(1);
    for (const t of study) expect(t.minutes).toBeLessThanOrEqual(50);
    expect(study[0]!.detail).toContain('A');
    expect(study.reduce((n, t) => n + (t.range!.to - t.range!.from + 1), 0)).toBe(40); // every page covered once
  });

  it('when time is short keeps the heavy and weak chapters and reports the rest', () => {
    const p = buildPlan(
      input({
        examDate: '2026-11-03', // 2 days
        settings: { dailyMinutes: 60, offDays: [], minutesPerPage: 4 },
        chapters: [chapter(1, 10, { weight: 0.2 }), chapter(2, 10, { weight: 0.8 })],
      }),
    );
    const planned = p.days.flatMap(keys);
    expect(planned).toContain('study:2:1');
    expect(planned).not.toContain('study:1:1');
    expect(p.overflow.map((t) => t.key)).toContain('study:1:1');
    expect(p.warnings.join(' ')).toContain('الوقت المتاح لا يكفي');
  });

  it('puts a strengthen task first for weak chapters', () => {
    const p = buildPlan(input({ chapters: [chapter(1, 10), chapter(2, 10, { accuracy: 0.4, weakTopics: ['Models'] })] }));
    expect(p.days[0]!.tasks[0]).toMatchObject({ key: 'strengthen:2', kind: 'strengthen' });
    expect(p.days[0]!.tasks[0]!.detail).toContain('Models');
    expect(p.warnings.join(' ')).toContain('«Ch2» نقطة ضعف (40%)');
  });

  it('adapts to delays: done tasks go to history, overdue ones are re-packed from today and flagged', () => {
    const state = new Map<string, TaskState>([
      ['study:1:1', { status: 'done', firstPlannedOn: '2026-10-30', doneOn: '2026-10-30', auto: false }],
      ['practice:1', { status: 'pending', firstPlannedOn: '2026-10-30', doneOn: null, auto: false }],
    ]);
    const p = buildPlan(input({ state }));
    expect(p.history.map((t) => [t.key, t.status, t.date])).toEqual([['study:1:1', 'done', '2026-10-30']]);
    expect(p.days[0]!.tasks[0]).toMatchObject({ key: 'practice:1', delayedFrom: '2026-10-30', date: TODAY });
    expect(p.warnings.join(' ')).toContain('تأخرت 1 مهام');
    expect(p.firstPlanned.get('study:2:1')! >= TODAY).toBe(true); // new tasks get their first day recorded
    expect(p.firstPlanned.has('practice:1')).toBe(false);
  });

  it('keeps tasks finished today on the day list, counting their time', () => {
    const state = new Map<string, TaskState>([['study:1:1', { status: 'done', firstPlannedOn: TODAY, doneOn: TODAY, auto: false }]]);
    const p = buildPlan(input({ state, settings: { dailyMinutes: 60, offDays: [], minutesPerPage: 4 } }));
    expect(p.days[0]!.tasks[0]).toMatchObject({ key: 'study:1:1', status: 'done' });
    expect(used(p.days[0]!)).toBeLessThanOrEqual(60);
    expect(p.stats.remainingMinutes).toBe(p.stats.totalMinutes - p.stats.doneMinutes);
  });

  it('marks practice done automatically after enough answers', () => {
    const p = buildPlan(input({ chapters: [chapter(1, 10, { practiceAnswers: 5 }), chapter(2, 10)] }));
    expect(p.autoDone).toEqual(['practice:1']);
    expect(p.history.find((t) => t.key === 'practice:1')).toMatchObject({ status: 'done', auto: true, date: TODAY });
  });

  it('adds today\'s review of due cards first', () => {
    const p = buildPlan(input({ dueCards: 4, learningCards: 6 }));
    expect(p.days[0]!.tasks[0]).toMatchObject({ key: `review:${TODAY}`, minutes: 6 });
  });

  it('handles an exam today', () => {
    const p = buildPlan(input({ examDate: TODAY }));
    expect(p.days).toEqual([]);
    expect(p.warnings[0]).toContain('الاختبار اليوم');
  });
});

describe('plan API', () => {
  let t: ReturnType<typeof makeTestApp>;
  let subjectId: number;
  let examId: number;

  beforeEach(async () => {
    t = makeTestApp();
    subjectId = (await t.json('POST', '/api/subjects', { name: 'BIO' })).body.id;
    const fileId = (await t.upload(subjectId, 'content', [{ name: 'course.pdf', data: fixture('course.pdf') }]))[0]!.fileId;
    await t.settle();
    examId = (await t.json('POST', `/api/subjects/${subjectId}/exams`, { title: 'الفصلي' })).body.exams[0].id;
    t.provider.script.segment = [
      () => ({
        chapters: [
          { title: 'Cell', ranges: [{ file: `F${fileId}`, from: 1, to: 4 }], topics: [] },
          { title: 'Enzymes', ranges: [{ file: `F${fileId}`, from: 5, to: 8 }], topics: [] },
        ],
      }),
    ];
    await t.json('POST', `/api/subjects/${subjectId}/chapters/auto`);
    await t.settle();
  });
  afterEach(() => t.cleanup());

  it('needs an exam date, then builds, follows the scope, records completion, and lists today\'s tasks', async () => {
    const noDate = await t.json('PUT', `/api/exams/${examId}/plan`, { dailyMinutes: 60, offDays: [], minutesPerPage: 4 });
    expect(noDate.status).toBe(400);
    expect(noDate.body.error).toContain('حدّد تاريخ الاختبار');

    expect((await t.json('PATCH', `/api/exams/${examId}`, { examDate: '2026-11-10' })).status).toBe(200);
    let res = (await t.json('GET', `/api/exams/${examId}/plan`)).body;
    expect(res.plan.days.length).toBe(9);
    expect(res.plan.scope.map((c: { title: string }) => c.title)).toEqual(['Cell', 'Enzymes']);
    expect(res.plan.warnings[0]).toContain('لم تحدّد نطاق');

    const [cell] = (await t.json('GET', `/api/subjects/${subjectId}/chapters`)).body.chapters;
    await t.json('PUT', `/api/exams/${examId}/scope`, { chapterIds: [cell.id] });
    res = (await t.json('GET', `/api/exams/${examId}/plan`)).body;
    expect(res.plan.scope.map((c: { title: string }) => c.title)).toEqual(['Cell']);
    const first = res.plan.days[0].tasks[0];
    expect(first.key).toBe(`study:${cell.id}:1`);
    const practiceDay = res.plan.days.find((d: { tasks: { key: string }[] }) => d.tasks.some((x) => x.key === `practice:${cell.id}`)).date;

    const today = (await t.json('GET', '/api/plans/today')).body;
    expect(today[0]).toMatchObject({ key: first.key, examTitle: 'الفصلي', subjectName: 'BIO' });

    const after = (await t.json('POST', `/api/exams/${examId}/plan/tasks`, { key: first.key, status: 'done' })).body;
    expect(after.history[0]).toMatchObject({ key: first.key, status: 'done', date: '2026-11-01' });
    expect(after.stats.doneMinutes).toBeGreaterThan(0);

    // Two days after the practice was due: it is re-scheduled from today and shown as delayed.
    t.clock.today = addDays(practiceDay, 2);
    const later = (await t.json('GET', `/api/exams/${examId}/plan`)).body.plan;
    const practice = later.days[0].tasks.find((x: { key: string }) => x.key === `practice:${cell.id}`);
    expect(practice.delayedFrom).toBe(practiceDay);

    expect((await t.json('POST', `/api/exams/${examId}/plan/tasks`, { key: 'rm -rf', status: 'done' })).status).toBe(400);
  });
});
