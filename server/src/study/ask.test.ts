import type { AskThreadDTO } from '@zakir/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AIRequest } from '../ai/provider.ts';
import { fixture, makeTestApp } from '../../test/helpers.ts';

describe('ask the material', () => {
  let t: ReturnType<typeof makeTestApp>;
  let subjectId: number;
  let fileId: number;

  beforeEach(async () => {
    t = makeTestApp();
    subjectId = (await t.json('POST', '/api/subjects', { name: 'BIO' })).body.id;
    fileId = (await t.upload(subjectId, 'content', [{ name: 'course.pdf', data: fixture('course.pdf') }]))[0]!.fileId;
    await t.settle();
  });
  afterEach(() => t.cleanup());

  const ref = (page: number) => ({ file: `F${fileId}`, page });
  /** Answers citing the first page that was sent. */
  const answer = (req: AIRequest) => {
    const page = Number(req.user.match(/\[F\d+:p(\d+)\]/)![1]);
    return { found: 'yes', segments: [{ text: 'إجابة من المصدر.', refs: [ref(page)] }], missing: '' };
  };
  const calls = (kind: string) => t.provider.calls.filter((c) => c.kind === kind);

  async function ask(question: string, extra: object = {}) {
    const res = await t.json<AskThreadDTO>('POST', `/api/subjects/${subjectId}/ask`, { question, ...extra });
    expect(res.status).toBe(200);
    await t.settle();
    return (await t.json<AskThreadDTO>('GET', `/api/ask-threads/${res.body.id}`)).body;
  }

  it('searches locally, answers from the found pages only, and stores cited refs', async () => {
    t.provider.script.ask = [answer];
    const thread = await ask('وش الفرق بين النقل النشط والنقل السلبي؟');
    const a = thread.asks[0]!;
    expect(calls('expand')).toHaveLength(0); // local search was enough
    expect(a).toMatchObject({ status: 'done', retrieval: 'search', dialect: 'fusha' });
    expect(a.pages[0]).toEqual({ fileId, page: 3 }); // the transport page ranks first
    const req = calls('ask')[0]!.req;
    expect(req.tools).toBe('none');
    expect(req.user).toContain(`[F${fileId}:p3]`);
    expect(req.user).not.toContain(`[F${fileId}:p1]`); // the cover is not relevant
    expect(req.system).toContain('بالعربية الفصحى');
    expect(a.result!.segments[0]!.refs).toEqual([{ fileId, page: 3 }]);
  });

  it('expands the query with AI only when local search is weak', async () => {
    t.provider.script.expand = [() => ({ terms: ['Mitochondria', 'الميتوكوندريا', 'ATP'] })];
    t.provider.script.ask = [answer];
    const a = (await ask('What is the powerhouse?')).asks[0]!;
    expect(calls('expand')).toHaveLength(1);
    expect(a.retrieval).toBe('search+expand');
    expect(a.pages.map((p) => p.page)).toContain(4);
  });

  it('says "not found" without an answer call when nothing matches', async () => {
    t.provider.script.expand = [() => ({ terms: ['Chloroplast', 'البناء الضوئي'] })];
    const a = (await ask('اشرح البناء الضوئي في البلاستيدات')).asks[0]!;
    expect(calls('ask')).toHaveLength(0);
    expect(a).toMatchObject({ status: 'done', pages: [] });
    expect(a.result).toMatchObject({ found: 'no', segments: [] });
    expect(a.result!.missing).toContain('لم أجد في ملفاتك');
  });

  it('uses the whole chapter or a topic range when scoped', async () => {
    t.provider.script.segment = [
      () => ({
        chapters: [
          { title: 'Cell', ranges: [{ file: `F${fileId}`, from: 1, to: 4 }], topics: [] },
          { title: 'Enzymes', ranges: [{ file: `F${fileId}`, from: 5, to: 8 }], topics: [{ title: 'Models', file: `F${fileId}`, from: 6, to: 6 }] },
        ],
      }),
    ];
    await t.json('POST', `/api/subjects/${subjectId}/chapters/auto`);
    await t.settle();
    const [, enzymes] = (await t.json('GET', `/api/subjects/${subjectId}/chapters`)).body.chapters;
    t.provider.script.ask = [answer];

    const a = (await ask('اشرح لي هذا الشابتر', { scope: { chapterId: enzymes.id } })).asks[0]!;
    expect(a.retrieval).toBe('scope');
    expect(a.pages.map((p) => p.page)).toEqual([5, 6, 7, 8]); // empty question terms do not matter
    expect(calls('ask')[0]!.req.user).toContain('نطاق البحث: «Enzymes» فقط');

    const b = (await ask('اشرح', { scope: { chapterId: enzymes.id, range: { fileId, from: 6, to: 6 }, label: 'Models' } })).asks[0]!;
    expect(b.pages).toEqual([{ fileId, page: 6 }]);
    const bad = await t.json('POST', `/api/subjects/${subjectId}/ask`, { question: 'اشرح', scope: { chapterId: enzymes.id, range: { fileId, from: 2, to: 2 } } });
    expect(bad.status).toBe(400);
  });

  it('rejects uncited segments, keeps follow-up context, and honours the dialect setting', async () => {
    const uncited = () => ({ found: 'yes', segments: [{ text: 'بلا مرجع', refs: [] }], missing: '' });
    t.provider.script.ask = [uncited, answer];
    const thread = await ask('ما هو الببسين؟');
    expect(calls('ask')[1]!.req.user).toContain('الفقرة 1 بلا مرجع');
    expect(thread.asks[0]!.status).toBe('done');

    expect((await t.json('PUT', '/api/settings', { dialect: 'saudi' })).body).toEqual({ dialect: 'saudi' });
    t.provider.script.ask = [answer];
    const res = await t.json<AskThreadDTO>('POST', `/api/subjects/${subjectId}/ask`, { threadId: thread.id, question: 'وعند أي pH يشتغل؟' });
    await t.settle();
    const followUp = calls('ask').at(-1)!.req;
    expect(followUp.user).toContain('سؤال 1: ما هو الببسين؟');
    expect(followUp.system).toContain('اللهجة السعودية');
    const after = (await t.json<AskThreadDTO>('GET', `/api/ask-threads/${res.body.id}`)).body;
    expect(after.asks.map((a) => a.dialect)).toEqual(['fusha', 'saudi']);
  });

  it('marks failures and retries them', async () => {
    const partialNoMissing = () => ({ found: 'partial', segments: [{ text: 'جزء', refs: [ref(3)] }], missing: '' });
    t.provider.script.ask = [partialNoMissing, partialNoMissing];
    const a = (await ask('ما هي مضخة الصوديوم والبوتاسيوم')).asks[0]!;
    expect(a.status).toBe('failed');
    expect(a.error).toContain('missing');

    t.provider.script.ask = [answer];
    await t.json('POST', `/api/asks/${a.id}/retry`);
    await t.settle();
    expect((await t.json<AskThreadDTO>('GET', `/api/ask-threads/${a.threadId}`)).body.asks[0]!.status).toBe('done');
  });
});
