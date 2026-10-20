// Pure study-plan builder. No AI and no database: given the exam, the scope chapters, the student's
// settings and current state (what is done, weaknesses, review load), it returns a day-by-day schedule.
// It is recomputed on every read, which is how the plan adapts:
//   - tasks left undone on past days are re-packed from today (and shown as delayed),
//   - weak chapters (accuracy < 60%) gain a "strengthen" task placed first,
//   - when time runs short, tasks are kept by priority (doctor's exam weight × weakness) and the rest
//     is listed as overflow instead of silently disappearing.

import type { PlanDayDTO, PlanSettings, PlanTaskDTO, PlanTaskKind } from '@zakir/shared';
import { addDays } from './review.ts';

export interface PlanChapter {
  id: number;
  title: string;
  pageCount: number;
  topics: { title: string; fileId: number; from: number; to: number }[];
  ranges: { fileId: number; from: number; to: number }[];
  hasSummary: boolean;
  /** Share of the doctor's past questions on this chapter (0..1), or null if unknown. */
  weight: number | null;
  /** Mean score on this chapter's questions, null if fewer than 2 answers. */
  accuracy: number | null;
  /** Topic titles under 60% — named in the strengthen task. */
  weakTopics: string[];
  /** Answers given on this chapter's questions since the plan was created. */
  practiceAnswers: number;
}

export interface TaskState {
  status: 'pending' | 'done' | 'skipped';
  firstPlannedOn: string | null;
  doneOn: string | null;
  auto: boolean;
}

export interface PlanInput {
  today: string;
  examDate: string;
  settings: PlanSettings;
  chapters: PlanChapter[];
  /** Cards due today and cards still being learned (for the daily review). */
  dueCards: number;
  learningCards: number;
  state: Map<string, TaskState>;
}

export interface PlanResult {
  days: PlanDayDTO[];
  overflow: PlanTaskDTO[];
  history: PlanTaskDTO[];
  /** Tasks that became done automatically in this computation (to persist). */
  autoDone: string[];
  /** First scheduled day of pending tasks that had none (to persist). */
  firstPlanned: Map<string, string>;
  stats: { totalMinutes: number; doneMinutes: number; remainingMinutes: number; availableMinutes: number; daysLeft: number };
  warnings: string[];
}

export const PRACTICE_MINUTES = 20;
export const STRENGTHEN_MINUTES = 25;
export const MOCK_MINUTES = 60;
export const FINAL_MINUTES = 30;
export const REVIEW_RESERVE = 10;
/** Answers on a chapter after which its practice task counts as done. */
export const PRACTICE_DONE_ANSWERS = 5;
const WEAK = 0.6;

type Draft = Omit<PlanTaskDTO, 'status' | 'date' | 'delayedFrom' | 'auto'> & { priority: number };

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const pageText = (r: { from: number; to: number }) => (r.from === r.to ? `ص ${r.from}` : `ص ${r.from}–${r.to}`);

/** Splits a chapter's study time into parts of at most `maxPart` minutes, by topic when possible, else by pages. */
function studyParts(ch: PlanChapter, minutesPerPage: number, maxPart: number) {
  const total = Math.max(15, Math.round(ch.pageCount * minutesPerPage));
  if (total <= maxPart) return [{ label: '', minutes: total, range: ch.ranges.length === 1 ? ch.ranges[0]! : null }];

  // Page units in reading order: topics if they cover the chapter well, else the ranges themselves.
  const topicPages = ch.topics.reduce((n, t) => n + t.to - t.from + 1, 0);
  const units = (ch.topics.length >= 2 && topicPages >= ch.pageCount * 0.6 ? ch.topics : ch.ranges.map((r) => ({ ...r, title: '' }))).flatMap((u) => {
    // Split any unit that alone exceeds a part.
    const pages = u.to - u.from + 1;
    const n = Math.ceil((pages * minutesPerPage) / maxPart);
    if (n <= 1) return [u];
    const size = Math.ceil(pages / n);
    return Array.from({ length: n }, (_, i) => ({ ...u, from: u.from + i * size, to: Math.min(u.to, u.from + (i + 1) * size - 1) })).filter((x) => x.from <= x.to);
  });

  const parts: { label: string; minutes: number; range: { fileId: number; from: number; to: number } | null; units: typeof units }[] = [];
  for (const u of units) {
    const m = Math.max(5, Math.round((u.to - u.from + 1) * minutesPerPage));
    const last = parts.at(-1);
    if (last && last.minutes + m <= maxPart && last.units.at(-1)!.fileId === u.fileId) {
      last.units.push(u);
      last.minutes += m;
    } else parts.push({ label: '', minutes: m, range: null, units: [u] });
  }
  return parts.map((p) => {
    const first = p.units[0]!;
    const last = p.units.at(-1)!;
    const titles = p.units.map((u) => u.title).filter(Boolean);
    const range = { fileId: first.fileId, from: first.from, to: last.to };
    return { label: titles.length ? titles.join('، ') : pageText(range), minutes: Math.max(10, p.minutes), range };
  });
}

/** All tasks the plan needs, in study order, with priorities for when time is short. */
function draftTasks(input: PlanInput, maxPart: number): Draft[] {
  const n = input.chapters.length || 1;
  const known = input.chapters.some((c) => c.weight !== null);
  const strengthen: Draft[] = [];
  const main: Draft[] = [];

  for (const ch of input.chapters) {
    // Exam weight relative to an even split (1 = average chapter); unknown → average.
    const rel = known ? Math.max(0.2, (ch.weight ?? 0) * n) : 1;
    const weak = ch.accuracy !== null && ch.accuracy < WEAK;
    const factor = rel * (weak ? 1.4 : 1);

    studyParts(ch, input.settings.minutesPerPage, maxPart).forEach((p, i, all) => {
      main.push({
        key: `study:${ch.id}:${i + 1}`,
        kind: 'study',
        title: `ذاكر: ${ch.title}${all.length > 1 ? ` (${i + 1}/${all.length})` : ''}`,
        detail: `${p.label ? `${p.label} — ` : ''}${ch.hasSummary ? 'ابدأ بالملخص المفصّل ثم ارجع للصفحات فيما لم يتضح.' : 'اقرأ الصفحات، ويمكنك توليد ملخص للشابتر.'}`,
        minutes: p.minutes,
        chapterId: ch.id,
        range: p.range,
        priority: 3 * factor,
      });
    });
    main.push({
      key: `practice:${ch.id}`,
      kind: 'practice',
      title: `تدرّب: ${ch.title}`,
      detail: `اختبار قصير على الشابتر (يُحسب منجزًا تلقائيًا بعد ${PRACTICE_DONE_ANSWERS} إجابات على أسئلته).`,
      minutes: PRACTICE_MINUTES,
      chapterId: ch.id,
      range: null,
      priority: 2.5 * factor,
    });
    if (weak) {
      strengthen.push({
        key: `strengthen:${ch.id}`,
        kind: 'strengthen',
        title: `تقوية: ${ch.title}`,
        detail: `دقتك ${Math.round(ch.accuracy! * 100)}%.${ch.weakTopics.length ? ` ركّز على: ${ch.weakTopics.join('، ')}.` : ''} اطلب شرحه ثم تدرّب عليه.`,
        minutes: STRENGTHEN_MINUTES,
        chapterId: ch.id,
        range: null,
        priority: 3.5 * rel,
      });
    }
  }
  // Known weaknesses are urgent: they come first.
  return [...strengthen, ...main];
}

export function buildPlan(input: PlanInput): PlanResult {
  const { today, examDate, settings, state } = input;
  const warnings: string[] = [];
  const autoDone: string[] = [];
  const firstPlanned = new Map<string, string>();

  // Study days: today … the day before the exam (the exam day itself is left free).
  const days: PlanDayDTO[] = [];
  for (let d = today; d < examDate; d = addDays(d, 1)) {
    const off = settings.offDays.includes(weekday(d));
    days.push({ date: d, capacity: off ? 0 : settings.dailyMinutes, reserved: 0, tasks: [] });
  }
  if (!days.length) warnings.push(examDate === today ? 'الاختبار اليوم — بالتوفيق! لا توجد أيام مذاكرة متبقية في الخطة.' : 'تاريخ الاختبار مضى.');

  const maxPart = Math.max(15, Math.min(60, settings.dailyMinutes - REVIEW_RESERVE));
  const drafts = draftTasks(input, maxPart);
  const chapterOf = new Map(input.chapters.map((c) => [c.id, c]));

  // Practice completes itself from activity.
  for (const t of drafts) {
    if (t.kind === 'practice' && state.get(t.key)?.status !== 'done' && (chapterOf.get(t.chapterId!)?.practiceAnswers ?? 0) >= PRACTICE_DONE_ANSWERS) {
      state.set(t.key, { status: 'done', firstPlannedOn: state.get(t.key)?.firstPlannedOn ?? null, doneOn: today, auto: true });
      autoDone.push(t.key);
    }
  }

  const finished = (t: Draft) => {
    const s = state.get(t.key);
    return s && s.status !== 'pending' ? s : undefined;
  };
  const history: PlanTaskDTO[] = [];
  const pending: Draft[] = [];
  for (const t of drafts) {
    const s = finished(t);
    if (s) history.push({ ...strip(t), status: s.status, date: s.doneOn, delayedFrom: null, auto: s.auto });
    else pending.push(t);
  }

  // Today's review of due cards, and a small daily reserve afterwards while cards are being learned.
  const today0 = days[0]?.date === today ? days[0] : undefined;
  if (today0 && input.dueCards > 0 && today0.capacity > 0) {
    const minutes = Math.min(30, Math.max(5, Math.round(input.dueCards * 1.5)));
    today0.tasks.push({
      key: `review:${today}`,
      kind: 'review',
      title: `راجع أخطاءك المستحقة (${input.dueCards})`,
      detail: 'مراجعة بطاقات التكرار المتباعد المستحقة اليوم — تُعتبر منجزة عندما لا يبقى شيء مستحق.',
      minutes,
      chapterId: null,
      range: null,
      status: 'pending',
      date: today,
      delayedFrom: null,
      auto: false,
    });
    today0.reserved = minutes;
  }
  // What was finished today stays on today's list (ticked) and counts against today's time.
  if (today0) for (const h of history) if (h.date === today && h.status === 'done' && !h.auto) today0.tasks.push(h);

  const willReview = input.learningCards > 0 || drafts.some((t) => t.kind === 'practice');
  for (const d of days) if (d.date !== today && d.capacity > 0 && willReview) d.reserved = Math.min(REVIEW_RESERVE, d.capacity);
  const free = (d: PlanDayDTO) => d.capacity - d.reserved - d.tasks.reduce((n, t) => n + (t.kind === 'review' ? 0 : t.minutes), 0);

  // Closing tasks: a mock exam (sized to fit a study day) and a final quick review. They compete on
  // priority like everything else — when time is short, studying a heavy chapter beats a mock exam.
  const mockMinutes = Math.max(30, Math.min(MOCK_MINUTES, settings.dailyMinutes - REVIEW_RESERVE));
  const closing: Draft[] = [
    { key: 'mock', kind: 'mock' as const, title: 'اختبار تجريبي شامل بوقت', detail: 'اختبار بوقت على كل نطاق الاختبار من بنك الأسئلة، ثم راجع أخطاءه.', minutes: mockMinutes, chapterId: null, range: null, priority: 2.2 },
    { key: 'final', kind: 'final' as const, title: 'مراجعة أخيرة سريعة', detail: 'مرّ على الملخصات السريعة لكل شباترات النطاق، وعلى أخطائك الأخيرة.', minutes: FINAL_MINUTES, chapterId: null, range: null, priority: 3.2 },
  ].filter((t) => !finished(t));
  let rest = [...pending, ...closing];

  // Not enough time → keep the highest-priority tasks (in their study order) and report the rest.
  const capacityLeft = days.reduce((n, d) => n + Math.max(0, free(d)), 0);
  const needed = rest.reduce((n, t) => n + t.minutes, 0);
  let overflow: Draft[] = [];
  if (needed > capacityLeft) {
    const keep = new Set<string>();
    let used = 0;
    for (const t of [...rest].sort((a, b) => b.priority - a.priority)) {
      if (used + t.minutes <= capacityLeft) {
        keep.add(t.key);
        used += t.minutes;
      }
    }
    overflow = rest.filter((t) => !keep.has(t.key));
    rest = rest.filter((t) => keep.has(t.key));
  }

  // Place kept closing tasks on the last days (final review last, mock before it), only within the last
  // quarter of the period — never at the start.
  const window = days.slice(-Math.max(2, Math.ceil(days.length / 4)));
  for (const key of ['final', 'mock']) {
    const t = rest.find((x) => x.key === key);
    if (!t) continue;
    rest = rest.filter((x) => x !== t);
    const day = [...window].reverse().find((d) => free(d) >= t.minutes);
    if (day) day.tasks.push(toPending(t, day.date));
    else overflow.push(t);
  }

  // Pack in order; a task never goes on an earlier day than the task before it. Work is spread evenly:
  // each day aims at an equal share of what is left (so the plan does not front-load day 1 and leave
  // the rest empty). If that does not fit everything, pack as early as possible instead.
  const studyDays = days.filter((d) => free(d) > 0).length || 1;
  const load = rest.reduce((n, t) => n + t.minutes, 0);
  const target = Math.max(30, Math.ceil(load / studyDays));
  const pack = (perDay: number) => {
    const placed = new Map<string, PlanDayDTO>();
    const planned = new Map<PlanDayDTO, number>();
    let cursor = 0;
    for (const t of rest) {
      const fits = (d: PlanDayDTO) => {
        const p = planned.get(d) ?? 0;
        return free(d) - p >= t.minutes && (p === 0 || p + t.minutes <= perDay);
      };
      while (cursor < days.length && !fits(days[cursor]!)) cursor++;
      const day = days[cursor];
      if (!day) return null;
      placed.set(t.key, day);
      planned.set(day, (planned.get(day) ?? 0) + t.minutes);
    }
    return placed;
  };
  const placed = pack(target) ?? pack(Infinity);
  for (const t of rest) {
    const day = placed?.get(t.key);
    if (!day) {
      overflow.push(t);
      continue;
    }
    // Insert before closing tasks of that day.
    const idx = day.tasks.findIndex((x) => x.kind === 'mock' || x.kind === 'final');
    day.tasks.splice(idx === -1 ? day.tasks.length : idx, 0, toPending(t, day.date));
  }

  // Within a day: review first, study/practice in order, then mock, then final.
  const rank = (k: PlanTaskKind) => (k === 'review' ? 0 : k === 'mock' ? 2 : k === 'final' ? 3 : 1);
  for (const d of days) d.tasks = d.tasks.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.kind) - rank(b.t.kind) || a.i - b.i).map((x) => x.t);

  // Delays: a pending task first planned for an earlier day.
  for (const d of days) {
    for (const t of d.tasks) {
      if (t.kind === 'review' || t.status !== 'pending') continue;
      const first = state.get(t.key)?.firstPlannedOn;
      if (first && first < d.date && first < today) t.delayedFrom = first;
      if (!first) firstPlanned.set(t.key, d.date);
    }
  }

  const delayed = days.flatMap((d) => d.tasks).filter((t) => t.delayedFrom).length;
  if (delayed) warnings.push(`تأخرت ${delayed} مهام عن موعدها الأول، فأعدت توزيعها على الأيام المتبقية.`);
  if (overflow.length) {
    const short = overflow.reduce((n, t) => n + t.minutes, 0);
    warnings.push(
      `الوقت المتاح لا يكفي كل الخطة: ينقصك نحو ${Math.ceil(short / 60)} ساعة. أبقيت المهام الأعلى وزنًا في اختبارات الدكتور والأضعف عندك، والباقي في «لم يتسع له الوقت». زد وقتك اليومي أو قلّل أيام الراحة.`,
    );
  }
  for (const c of input.chapters) if (c.accuracy !== null && c.accuracy < WEAK) warnings.push(`«${c.title}» نقطة ضعف (${Math.round(c.accuracy * 100)}%) — أضفت له مهمة تقوية في أول الخطة.`);

  const doneMinutes = history.filter((t) => t.status === 'done').reduce((n, t) => n + t.minutes, 0);
  const remainingMinutes = days.flatMap((d) => d.tasks).filter((t) => t.status === 'pending').reduce((n, t) => n + t.minutes, 0) + overflow.reduce((n, t) => n + t.minutes, 0);
  return {
    days,
    overflow: overflow.map((t) => ({ ...strip(t), status: 'pending' as const, date: null, delayedFrom: null, auto: false })),
    history,
    autoDone,
    firstPlanned,
    stats: {
      totalMinutes: doneMinutes + remainingMinutes,
      doneMinutes,
      remainingMinutes,
      availableMinutes: days.reduce((n, d) => n + d.capacity, 0),
      daysLeft: days.length,
    },
    warnings,
  };
}

function strip(t: Draft): Omit<PlanTaskDTO, 'status' | 'date' | 'delayedFrom' | 'auto'> {
  const { priority: _p, ...rest } = t;
  return rest;
}

function toPending(t: Draft, date: string): PlanTaskDTO {
  return { ...strip(t), status: 'pending', date, delayedFrom: null, auto: false };
}

export type { PlanTaskKind };
