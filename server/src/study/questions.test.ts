import type { QuestionDTO, QuestionSetDTO, QuizDTO, StyleProfileDTO } from '@zakir/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AIRequest } from '../ai/provider.ts';
import { fixture, makeTestApp } from '../../test/helpers.ts';
import { overlap } from '../ai/tasks/questions.ts';
import { confidenceFor } from './style.ts';

describe('overlap (anti-copy check)', () => {
  it('flags near-copies of past questions but not new questions in the same style', () => {
    const past = 'List the two types of transport across the membrane with one example of each. (4 marks)';
    expect(overlap('List the two types of transport across the membrane with one example of each.', past)).toBeGreaterThanOrEqual(0.8);
    expect(overlap('Which of the following is NOT one of the principles of the cell theory?', 'Which of the following is NOT one of the principles of the cell theory\na. All...')).toBe(1);
    expect(overlap('Which of the following is the site of protein synthesis?', 'Which of the following modifies and packages proteins?')).toBeLessThan(0.8);
  });
});

describe('confidenceFor', () => {
  it.each([
    [1, 30, 'low'],
    [3, 10, 'low'],
    [2, 15, 'medium'],
    [4, 39, 'medium'],
    [4, 40, 'high'],
  ] as const)('%i exams, %i questions → %s', (e, q, level) => expect(confidenceFor(e, q).level).toBe(level));
});

describe('style, questions, verification, quizzes', () => {
  let t: ReturnType<typeof makeTestApp>;
  let subjectId: number;
  let contentId: number;
  let examId: number;
  let ch: number[]; // chapter ids

  beforeEach(async () => {
    t = makeTestApp();
    subjectId = (await t.json('POST', '/api/subjects', { name: 'BIO 101' })).body.id;
    contentId = (await t.upload(subjectId, 'content', [{ name: 'course.pdf', data: fixture('course.pdf') }]))[0]!.fileId;
    examId = (await t.upload(subjectId, 'past_exam', [{ name: 'final 2024.pdf', data: fixture('text.pdf') }]))[0]!.fileId;
    await t.settle();
    t.provider.script.segment = [
      () => ({
        chapters: [
          { title: 'Cell Structure', ranges: [{ file: `F${contentId}`, from: 1, to: 4 }], topics: [] },
          { title: 'Enzymes', ranges: [{ file: `F${contentId}`, from: 5, to: 8 }], topics: [] },
        ],
      }),
    ];
    await t.json('POST', `/api/subjects/${subjectId}/chapters/auto`);
    await t.settle();
    ch = (await t.json('GET', `/api/subjects/${subjectId}/chapters`)).body.chapters.map((c: { id: number }) => c.id);
  });
  afterEach(() => t.cleanup());

  const ref = (page: number, file = contentId) => ({ file: `F${file}`, page });

  // ---------- style ----------

  const styleAnswer = () => ({
    examsDetected: 1,
    totalQuestions: 10,
    language: 'English',
    structure: 'قسمان: اختيار من متعدد ثم أسئلة قصيرة',
    types: [
      { type: 'mcq', count: 7 },
      { type: 'short_answer', count: 3 },
    ],
    chapters: [
      { chapter: 'C1', count: 6 },
      { chapter: 'C2', count: 3 },
      { chapter: 'none', count: 1 },
    ],
    recurringTopics: [{ topic: 'الميتوكوندريا', count: 2, refs: [ref(2, examId)] }],
    phrasing: ['يبدأ كثيرًا بـ Which of the following'],
    examples: [
      { type: 'mcq', text: 'Which organelle produces ATP?', refs: [ref(2, examId)] },
      { type: 'short_answer', text: 'Define the cell.', refs: [ref(1, examId)] },
    ],
  });

  it('analyzes past exams only, maps chapters, computes percentages and confidence', async () => {
    t.provider.script.style = [styleAnswer];
    await t.json('POST', `/api/subjects/${subjectId}/style/analyze`);
    await t.settle();
    const { req } = t.provider.calls.find((c) => c.kind === 'style')!;
    expect(req.user).toContain('C1: Cell Structure');
    expect(req.user).toContain(`[F${examId}:p1]`);
    expect(req.user).not.toContain(`[F${contentId}:`); // content files are not exams

    const s = (await t.json<{ style: StyleProfileDTO }>('GET', `/api/subjects/${subjectId}/style`)).body.style;
    expect(s.profile.types).toEqual([
      { type: 'mcq', count: 7, percent: 70 },
      { type: 'short_answer', count: 3, percent: 30 },
    ]);
    expect(s.profile.chapters.map((c) => [c.chapterId, c.title, c.percent])).toEqual([
      [ch[0], 'Cell Structure', 60],
      [ch[1], 'Enzymes', 30],
      [null, 'غير مرتبط بشابتر', 10],
    ]);
    expect(s.profile.recurringTopics[0]!.refs).toEqual([{ fileId: examId, page: 2 }]);
    expect(s.confidence).toBe('low');
    expect(s.confidenceReason).toContain('1 اختبار و10 سؤالًا');
    expect(s.outdated).toBe(false);

    await t.upload(subjectId, 'past_exam', [{ name: 'midterm.pdf', data: Buffer.concat([fixture('text.pdf'), Buffer.from('\n%2\n')]) }]);
    await t.settle();
    expect((await t.json('GET', `/api/subjects/${subjectId}/style`)).body.style.outdated).toBe(true);
  });

  it('retries the analysis when counts do not add up', async () => {
    const wrong = () => ({ ...styleAnswer(), totalQuestions: 12 });
    t.provider.script.style = [wrong, styleAnswer];
    await t.json('POST', `/api/subjects/${subjectId}/style/analyze`);
    await t.settle();
    const calls = t.provider.calls.filter((c) => c.kind === 'style');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.req.user).toContain('مجموع types (10) يجب أن يساوي totalQuestions (12)');
  });

  // ---------- generation + verification ----------

  const threeQuestions = () => ({
    questions: [
      {
        type: 'mcq', difficulty: 'easy', chapter: 'C1', stem: 'Which organelle produces ATP?',
        options: ['Nucleus', 'Mitochondria', 'Golgi apparatus', 'Ribosome'], correctIndex: 1,
        optionExplanations: ['النواة تحتوي DNA', 'صحيح: مكان التنفس الخلوي', 'جولجي يغلّف البروتينات', 'الرايبوسوم يصنع البروتين'],
        explanation: 'الميتوكوندريا مكان إنتاج ATP.', refs: [ref(4)],
      },
      { type: 'true_false', difficulty: 'easy', chapter: 'C2', stem: 'Enzymes are consumed in the reaction.', correct: false, explanation: 'لا تُستهلك.', refs: [ref(5)] },
      {
        type: 'essay', difficulty: 'medium', chapter: 'C2', stem: 'Compare lock-and-key and induced fit models.',
        modelAnswer: 'القفل والمفتاح: تطابق تام. التلاؤم المستحث: يتغير الموقع النشط.',
        keyPoints: [{ text: 'القفل والمفتاح: تطابق تام', refs: [ref(6)] }, { text: 'التلاؤم المستحث: يتغير شكل الموقع النشط', refs: [ref(6)] }],
        explanation: 'من صفحة النماذج.', refs: [ref(6)],
      },
    ],
  });

  /** Verifier: accepts all but the true/false question. */
  const verifier = (req: AIRequest) => ({
    results: [...req.user.matchAll(/=== Q(\d+)\nالنوع: (\w+)/g)].map(([, id, type]) => ({
      question: `Q${id}`,
      verdict: type === 'true_false' ? 'reject' : 'ok',
      reason: type === 'true_false' ? 'العبارة غير مذكورة حرفيًا' : '',
    })),
  });

  async function generateSet(count = 3) {
    t.provider.script.generate = [threeQuestions];
    t.provider.script.verify = [verifier];
    const set = (await t.json<QuestionSetDTO>('POST', `/api/subjects/${subjectId}/question-sets`, { chapterIds: ch, type: 'mixed', difficulty: 'mixed', count })).body;
    await t.settle();
    return (await t.json<QuestionSetDTO[]>('GET', `/api/subjects/${subjectId}/question-sets`)).body.find((s) => s.id === set.id)!;
  }

  it('generates from the chosen chapters, verifies against cited pages only, and banks verified questions', async () => {
    const set = await generateSet();
    expect(set).toMatchObject({ status: 'ready', requested: 3, usedStyle: false, counts: { active: 2, rejected: 1, pending: 0, reported: 0 } });

    const gen = t.provider.calls.find((c) => c.kind === 'generate')!.req;
    expect(gen.user).toContain('### C1: Cell Structure');
    expect(gen.user).toContain('لا يوجد ملف أسلوب');
    const ver = t.provider.calls.find((c) => c.kind === 'verify')!.req;
    expect(ver.user).toContain(`[F${contentId}:p4]`);
    expect(ver.user).not.toContain(`[F${contentId}:p2]`); // not cited by any question
    expect(ver.user).toContain('B) Mitochondria   ← الإجابة المعتبرة');

    const bank = (await t.json<QuestionDTO[]>('GET', `/api/subjects/${subjectId}/questions`)).body;
    const rejected = bank.find((q) => q.status === 'rejected')!;
    expect(rejected).toMatchObject({ type: 'true_false', statusNote: 'العبارة غير مذكورة حرفيًا' });
    const mcq = bank.find((q) => q.type === 'mcq')!;
    expect(mcq.chapterId).toBe(ch[0]);
    expect(mcq.refs).toEqual([{ fileId: contentId, page: 4 }]);
    expect(mcq.answer!.correctIndex).toBe(1);
  });

  it('uses the style profile when present', async () => {
    t.provider.script.style = [styleAnswer];
    await t.json('POST', `/api/subjects/${subjectId}/style/analyze`);
    await t.settle();
    const set = await generateSet();
    expect(set.usedStyle).toBe(true);
    const gen = t.provider.calls.find((c) => c.kind === 'generate')!.req;
    expect(gen.user).toContain('لغة الأسئلة: English');
    expect(gen.user).toContain('يبدأ كثيرًا بـ Which of the following');
    expect(gen.user).toContain('Which organelle produces ATP?');
  });

  it('rejects generated output with bad refs or the wrong count, then retries', async () => {
    const bad = () => ({ questions: threeQuestions().questions.slice(0, 2).map((q) => ({ ...q, refs: [ref(99)], explanation: 'Mitochondria produce ATP.' })) });
    t.provider.script.generate = [bad, threeQuestions];
    t.provider.script.verify = [verifier];
    await t.json('POST', `/api/subjects/${subjectId}/question-sets`, { chapterIds: ch, type: 'mixed', difficulty: 'mixed', count: 3 });
    await t.settle();
    const second = t.provider.calls.filter((c) => c.kind === 'generate')[1]!.req.user;
    expect(second).toContain('المطلوب 3 سؤالًا بالضبط (الآن 2)');
    expect(second).toContain(`المرجع F${contentId}:p99 ليس من الصفحات المرسلة`);
    expect(second).toContain('explanation يجب أن يكون بالعربية الفصحى');
  });

  it('never shows unverified questions: a failed verification keeps them out of the bank and quizzes', async () => {
    t.provider.script.generate = [threeQuestions];
    t.provider.script.verify = [() => ({ results: [] }), () => ({ results: [] })];
    const set = (await t.json('POST', `/api/subjects/${subjectId}/question-sets`, { chapterIds: ch, type: 'mixed', difficulty: 'mixed', count: 3 })).body;
    await t.settle();
    const s = (await t.json<QuestionSetDTO[]>('GET', `/api/subjects/${subjectId}/question-sets`)).body[0]!;
    expect(s.status).toBe('failed');
    expect(s.error).toContain('فشل التحقق');
    expect(s.counts.pending).toBe(3);
    expect((await t.json('GET', `/api/subjects/${subjectId}/questions`)).body).toEqual([]);
    const quiz = await t.json('POST', `/api/subjects/${subjectId}/quizzes`, { setId: set.id });
    expect(quiz.status).toBe(400);
    expect(quiz.body.error).toContain('لا توجد أسئلة مُتحقق منها');

    t.provider.script.verify = [verifier];
    await t.json('POST', `/api/question-sets/${set.id}/verify`);
    await t.settle();
    expect((await t.json<QuestionSetDTO[]>('GET', `/api/subjects/${subjectId}/question-sets`)).body[0]!.counts).toMatchObject({ active: 2, rejected: 1, pending: 0 });
  });

  // ---------- quiz ----------

  it('runs a quiz: hides answers until answered, grades choices locally and essays by AI', async () => {
    const set = await generateSet();
    let quiz = (await t.json<QuizDTO>('POST', `/api/subjects/${subjectId}/quizzes`, { setId: set.id })).body;
    expect(quiz.items).toHaveLength(2); // the rejected question is not included
    expect(quiz.items.every((i) => i.question.answer === undefined)).toBe(true);

    const mcq = quiz.items.find((i) => i.question.type === 'mcq')!.question;
    const essay = quiz.items.find((i) => i.question.type === 'essay')!.question;
    quiz = (await t.json('POST', `/api/quizzes/${quiz.id}/answer`, { questionId: mcq.id, choice: 0 })).body;
    const mItem = quiz.items.find((i) => i.question.id === mcq.id)!;
    expect(mItem.attempt).toMatchObject({ status: 'graded', score: 0 });
    expect(mItem.question.answer!.optionExplanations![0]).toBe('النواة تحتوي DNA'); // why my choice is wrong

    const again = await t.json('POST', `/api/quizzes/${quiz.id}/answer`, { questionId: mcq.id, choice: 1 });
    expect(again.status).toBe(409);

    t.provider.script.grade = [
      () => ({
        keyPoints: [
          { index: 0, status: 'covered', note: 'صحيح' },
          { index: 1, status: 'missing', note: 'لم تذكر تغيّر شكل الموقع النشط' },
        ],
        mistakes: [{ quote: 'الإنزيم يُستهلك', why: 'الإنزيمات لا تُستهلك في التفاعل', refs: [ref(6)] }],
        summary: 'إجابة جزئية.',
      }),
    ];
    quiz = (await t.json('POST', `/api/quizzes/${quiz.id}/answer`, { questionId: essay.id, text: 'القفل والمفتاح تطابق تام، والإنزيم يُستهلك' })).body;
    expect(quiz.items.find((i) => i.question.id === essay.id)!.attempt!.status).toBe('grading');
    await t.settle();
    const grade = t.provider.calls.find((c) => c.kind === 'grade')!.req;
    expect(grade.user).toContain('0. القفل والمفتاح: تطابق تام');
    expect(grade.user).toContain(`[F${contentId}:p6]`);

    quiz = (await t.json('POST', `/api/quizzes/${quiz.id}/finish`)).body;
    const eItem = quiz.items.find((i) => i.question.id === essay.id)!;
    expect(eItem.attempt).toMatchObject({ status: 'graded', score: 0.5 });
    expect(eItem.attempt!.feedback!.mistakes[0]!.refs).toEqual([{ fileId: contentId, page: 6 }]);
    expect(quiz.score).toBe(0.25); // (0 + 0.5) / 2
  });

  it('a grade citing a page the grader was not given fails clearly and can be retried', async () => {
    const set = await generateSet();
    const quiz = (await t.json<QuizDTO>('POST', `/api/subjects/${subjectId}/quizzes`, { setId: set.id })).body;
    const essay = quiz.items.find((i) => i.question.type === 'essay')!.question;
    const bad = () => ({ keyPoints: [{ index: 0, status: 'covered', note: '' }, { index: 1, status: 'covered', note: '' }], mistakes: [{ quote: 'x', why: 'y', refs: [ref(2)] }], summary: 's' });
    t.provider.script.grade = [bad, bad];
    await t.json('POST', `/api/quizzes/${quiz.id}/answer`, { questionId: essay.id, text: 'إجابة' });
    await t.settle();
    let item = (await t.json<QuizDTO>('GET', `/api/quizzes/${quiz.id}`)).body.items.find((i) => i.question.id === essay.id)!;
    expect(item.attempt!.status).toBe('failed');
    expect(item.attempt!.error).toContain('ليس من الصفحات المرسلة');

    t.provider.script.grade = [() => ({ ...bad(), mistakes: [] })];
    await t.json('POST', `/api/quizzes/${quiz.id}/regrade`, { questionId: essay.id });
    await t.settle();
    item = (await t.json<QuizDTO>('GET', `/api/quizzes/${quiz.id}`)).body.items.find((i) => i.question.id === essay.id)!;
    expect(item.attempt).toMatchObject({ status: 'graded', score: 1 });
  });

  it('timed quizzes stop accepting answers when time is up', async () => {
    const set = await generateSet();
    const quiz = (await t.json<QuizDTO>('POST', `/api/subjects/${subjectId}/quizzes`, { setId: set.id, timeLimitMin: 1 })).body;
    expect(quiz.timeLimitSec).toBe(60);
    t.db.prepare(`UPDATE quiz_sessions SET started_at = ? WHERE id = ?`).run(new Date(Date.now() - 61_000).toISOString(), quiz.id);
    const res = await t.json('POST', `/api/quizzes/${quiz.id}/answer`, { questionId: quiz.items[0]!.question.id, choice: 0, bool: true, text: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('انتهى وقت الاختبار.');
    const after = (await t.json<QuizDTO>('GET', `/api/quizzes/${quiz.id}`)).body;
    expect(after.finishedAt).not.toBeNull();
    expect(after.score).toBe(0);
    expect(after.items[0]!.question.answer).toBeDefined(); // answers shown after the end
  });

  it('reported questions leave the pool until restored', async () => {
    const set = await generateSet();
    const bank = (await t.json<QuestionDTO[]>('GET', `/api/subjects/${subjectId}/questions`)).body;
    const mcq = bank.find((q) => q.type === 'mcq')!;
    expect((await t.json('POST', `/api/questions/${mcq.id}/report`, { note: 'ا' })).status).toBe(400);
    await t.json('POST', `/api/questions/${mcq.id}/report`, { note: 'الخيار ج صحيح أيضًا' });
    const quiz = (await t.json<QuizDTO>('POST', `/api/subjects/${subjectId}/quizzes`, { setId: set.id })).body;
    expect(quiz.items.map((i) => i.question.type)).toEqual(['essay']);
    const reported = (await t.json<QuestionDTO[]>('GET', `/api/subjects/${subjectId}/questions`)).body.find((q) => q.id === mcq.id)!;
    expect(reported).toMatchObject({ status: 'reported', statusNote: 'الخيار ج صحيح أيضًا' });
    await t.json('POST', `/api/questions/${mcq.id}/restore`);
    expect((await t.json<QuizDTO>('POST', `/api/subjects/${subjectId}/quizzes`, { setId: set.id })).body.items).toHaveLength(2);
  });
});
