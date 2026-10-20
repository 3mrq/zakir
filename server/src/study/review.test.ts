import type { MistakeDTO, QuizDTO, ReviewSubjectDTO, WeaknessesDTO } from '@zakir/shared';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AIRequest } from '../ai/provider.ts';
import { fixture, makeTestApp } from '../../test/helpers.ts';
import { addDays, schedule } from './review.ts';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

describe('Leitner schedule', () => {
  const today = '2026-11-01';
  it('moves up one box per right answer with growing intervals, and masters after box 5', () => {
    expect(schedule(1, 1, today)).toEqual({ box: 2, dueOn: '2026-11-04', mastered: false, lapse: false });
    expect(schedule(2, 0.8, today)).toMatchObject({ box: 3, dueOn: '2026-11-08' });
    expect(schedule(3, 1, today)).toMatchObject({ box: 4, dueOn: '2026-11-15' });
    expect(schedule(4, 1, today)).toMatchObject({ box: 5, dueOn: '2026-12-01' });
    expect(schedule(5, 1, today)).toMatchObject({ box: 5, mastered: true });
  });
  it('sends wrong answers back to box 1 tomorrow, and keeps partial answers in place', () => {
    expect(schedule(4, 0, today)).toEqual({ box: 1, dueOn: '2026-11-02', mastered: false, lapse: true });
    expect(schedule(3, 0.5, today)).toEqual({ box: 3, dueOn: '2026-11-02', mastered: false, lapse: false });
  });
  it('adds days across months and years', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('mistake log, review sessions, weaknesses', () => {
  let t: ReturnType<typeof makeTestApp>;
  let subjectId: number;
  let fileId: number;
  let mcqId: number;
  let tfId: number;
  let essayId: number;

  beforeEach(async () => {
    t = makeTestApp();
    subjectId = (await t.json('POST', '/api/subjects', { name: 'BIO' })).body.id;
    fileId = (await t.upload(subjectId, 'content', [{ name: 'course.pdf', data: fixture('course.pdf') }]))[0]!.fileId;
    await t.settle();
    const F = `F${fileId}`;
    t.provider.script.segment = [
      () => ({
        chapters: [
          { title: 'Cell', ranges: [{ file: F, from: 1, to: 4 }], topics: [{ title: 'Organelles', file: F, from: 4, to: 4 }, { title: 'Membrane', file: F, from: 3, to: 3 }] },
          { title: 'Enzymes', ranges: [{ file: F, from: 5, to: 8 }], topics: [{ title: 'Models', file: F, from: 6, to: 6 }] },
        ],
      }),
    ];
    await t.json('POST', `/api/subjects/${subjectId}/chapters/auto`);
    await t.settle();
    const ch = (await t.json('GET', `/api/subjects/${subjectId}/chapters`)).body.chapters.map((c: { id: number }) => c.id);
    t.provider.script.generate = [
      () => ({
        questions: [
          {
            type: 'mcq', difficulty: 'easy', chapter: 'C1', stem: 'Which organelle produces ATP?', options: ['Nucleus', 'Mitochondria', 'Golgi'], correctIndex: 1,
            optionExplanations: ['خطأ', 'صحيح', 'خطأ'], explanation: 'الميتوكوندريا.', refs: [{ file: F, page: 4 }],
          },
          { type: 'true_false', difficulty: 'easy', chapter: 'C1', stem: 'Osmosis needs ATP.', correct: false, explanation: 'نقل سلبي.', refs: [{ file: F, page: 3 }] },
          {
            type: 'essay', difficulty: 'medium', chapter: 'C2', stem: 'Compare the two models.', modelAnswer: 'نموذج', explanation: 'شرح.',
            keyPoints: [{ text: 'القفل والمفتاح', refs: [{ file: F, page: 6 }] }, { text: 'التلاؤم المستحث', refs: [{ file: F, page: 6 }] }], refs: [{ file: F, page: 6 }],
          },
        ],
      }),
    ];
    t.provider.script.verify = [(req: AIRequest) => ({ results: [...req.user.matchAll(/=== Q(\d+)/g)].map(([, id]) => ({ question: `Q${id}`, verdict: 'ok', reason: '' })) })];
    await t.json('POST', `/api/subjects/${subjectId}/question-sets`, { chapterIds: ch, type: 'mixed', difficulty: 'mixed', count: 3 });
    await t.settle();
    const bank = (await t.json('GET', `/api/subjects/${subjectId}/questions`)).body as { id: number; type: string }[];
    mcqId = bank.find((q) => q.type === 'mcq')!.id;
    tfId = bank.find((q) => q.type === 'true_false')!.id;
    essayId = bank.find((q) => q.type === 'essay')!.id;
  });
  afterEach(() => t.cleanup());

  const today = async () => (await t.json<ReviewSubjectDTO[]>('GET', '/api/review/today')).body.find((s) => s.subjectId === subjectId)!;
  const answer = (quizId: number, questionId: number, a: object) => t.json<QuizDTO>('POST', `/api/quizzes/${quizId}/answer`, { questionId, ...a });
  const practice = async () => (await t.json<QuizDTO>('POST', `/api/subjects/${subjectId}/quizzes`, { count: 10 })).body;
  const startReview = () => t.json<QuizDTO & { error?: string }>('POST', `/api/subjects/${subjectId}/review`);
  const card = (quiz: QuizDTO, qid: number) => quiz.items.find((i) => i.question.id === qid)!.card;

  it('a wrong quiz answer creates a card for tomorrow; right answers create none', async () => {
    const q = await practice();
    let res = (await answer(q.id, mcqId, { choice: 0 })).body;
    expect(card(res, mcqId)).toEqual({ box: 1, dueOn: '2026-11-02', mastered: false });
    res = (await answer(q.id, tfId, { bool: false })).body;
    expect(card(res, tfId)).toBeNull();

    expect(await today()).toMatchObject({ due: 0, learning: 1, nextDueOn: '2026-11-02', boxes: [1, 0, 0, 0, 0] });
    const none = await startReview();
    expect(none.status).toBe(400);
    expect(none.body.error).toContain('لا توجد مراجعات مستحقة اليوم');
  });

  it('reviews move a card through the boxes to mastery; a lapse sends it back', async () => {
    await answer((await practice()).id, mcqId, { choice: 2 });
    const reviewRight = async (day: string) => {
      t.clock.today = day;
      const r = (await startReview()).body;
      expect(r.kind).toBe('review');
      expect(r.items.map((i) => i.question.id)).toEqual([mcqId]);
      return card((await answer(r.id, mcqId, { choice: 1 })).body, mcqId)!;
    };
    expect(await reviewRight('2026-11-02')).toEqual({ box: 2, dueOn: '2026-11-05', mastered: false });

    // A lapse on 11-05 → box 1, tomorrow.
    t.clock.today = '2026-11-05';
    const r = (await startReview()).body;
    expect(card((await answer(r.id, mcqId, { choice: 0 })).body, mcqId)).toEqual({ box: 1, dueOn: '2026-11-06', mastered: false });

    expect(await reviewRight('2026-11-06')).toMatchObject({ box: 2, dueOn: '2026-11-09' });
    expect(await reviewRight('2026-11-09')).toMatchObject({ box: 3, dueOn: '2026-11-16' });
    expect(await reviewRight('2026-11-16')).toMatchObject({ box: 4, dueOn: '2026-11-30' });
    expect(await reviewRight('2026-11-30')).toMatchObject({ box: 5, dueOn: '2026-12-30' });
    expect(await reviewRight('2026-12-30')).toMatchObject({ box: 5, mastered: true });

    t.clock.today = '2027-03-01';
    expect(await today()).toMatchObject({ due: 0, learning: 0, mastered: 1 });
    const log = t.db.prepare(`SELECT source, box_before, box_after FROM review_log ORDER BY id`).all();
    expect(log[0]).toEqual({ source: 'quiz', box_before: null, box_after: 1 });
    expect(log).toHaveLength(8);

    // A new mistake on a mastered question brings it back.
    await answer((await practice()).id, mcqId, { choice: 0 });
    expect(await today()).toMatchObject({ learning: 1, mastered: 0, nextDueOn: '2027-03-02' });
  });

  it('a right answer in a normal quiz does not promote a card that is not due yet', async () => {
    await answer((await practice()).id, mcqId, { choice: 0 }); // box 1, due 11-02
    await answer((await practice()).id, mcqId, { choice: 1 }); // same day, not due
    expect(t.db.prepare(`SELECT box, due_on FROM review_cards`).get()).toEqual({ box: 1, due_on: '2026-11-02' });
    t.clock.today = '2026-11-02';
    await answer((await practice()).id, mcqId, { choice: 1 }); // due → counts
    expect(t.db.prepare(`SELECT box, due_on FROM review_cards`).get()).toEqual({ box: 2, due_on: '2026-11-05' });
  });

  it('essay grades feed the schedule when grading finishes (partial stays in its box)', async () => {
    const grade = (status: string) => () => ({ keyPoints: [{ index: 0, status: 'covered', note: '' }, { index: 1, status, note: '' }], mistakes: [], summary: 'ملخص' });
    t.provider.script.grade = [grade('missing')];
    await answer((await practice()).id, essayId, { text: 'القفل والمفتاح فقط' });
    await t.settle();
    expect(t.db.prepare(`SELECT box, due_on FROM review_cards WHERE question_id = ?`).get(essayId)).toEqual({ box: 1, due_on: '2026-11-02' });

    t.clock.today = '2026-11-02';
    t.provider.script.grade = [grade('partial')]; // 0.75 → stays
    const r = (await startReview()).body;
    await answer(r.id, essayId, { text: 'محاولة أفضل' });
    await t.settle();
    expect(t.db.prepare(`SELECT box, due_on FROM review_cards WHERE question_id = ?`).get(essayId)).toEqual({ box: 1, due_on: '2026-11-03' });
  });

  it('migration 006 turns earlier mistakes into cards due today (backfill SQL)', async () => {
    const q = await practice();
    await answer(q.id, mcqId, { choice: 0 });
    await answer(q.id, tfId, { bool: true });
    await answer(q.id, essayId, { text: 'x' }); // still grading → not a mistake yet
    t.db.prepare(`DELETE FROM review_cards`).run(); // as before phase 6
    const sql = readFileSync(join(MIGRATIONS, '006_review.sql'), 'utf8');
    t.db.exec(sql.slice(sql.indexOf('INSERT INTO review_cards')));
    const today = t.db.prepare(`SELECT date('now','localtime') d`).get() as { d: string };
    expect(t.db.prepare(`SELECT question_id, box, due_on, lapses FROM review_cards ORDER BY question_id`).all()).toEqual(
      [mcqId, tfId].sort((a, b) => a - b).map((id) => ({ question_id: id, box: 1, due_on: today.d, lapses: 1 })),
    );
  });

  it('lists mistakes and ranks weak chapters and topics (topics found through source pages)', async () => {
    let q = await practice();
    await answer(q.id, mcqId, { choice: 0 }); // wrong, Cell / Organelles (p4)
    await answer(q.id, tfId, { bool: false }); // right, Cell / Membrane (p3)
    q = await practice();
    await answer(q.id, mcqId, { choice: 2 }); // wrong again
    await answer(q.id, tfId, { bool: true }); // wrong, Membrane

    const m = (await t.json<MistakeDTO[]>('GET', `/api/subjects/${subjectId}/mistakes`)).body;
    expect(m).toHaveLength(3);
    expect(m[0]).toMatchObject({ score: 0, chapterTitle: 'Cell', card: { box: 1 } });
    expect(m[0]!.question.answer).toBeDefined();

    const w = (await t.json<WeaknessesDTO>('GET', `/api/subjects/${subjectId}/weaknesses`)).body;
    expect(w.chapters[0]).toMatchObject({ title: 'Cell', attempts: 4, accuracy: 0.25, wrong: 3, openCards: 2 });
    expect(w.chapters.at(-1)).toMatchObject({ title: 'Enzymes', attempts: 0 }); // untouched last
    expect(w.topics.map((x) => [x.title, x.attempts, x.accuracy])).toEqual([
      ['Organelles', 2, 0],
      ['Membrane', 2, 0.5],
      ['Models', 0, 0],
    ]);
    expect(w.topics[0]!.range).toEqual({ fileId, from: 4, to: 4 });
  });
});
