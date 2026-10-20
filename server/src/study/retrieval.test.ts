import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixture, makeTestApp } from '../../test/helpers.ts';
import { ftsQuery, searchPages, searchTerms } from './retrieval.ts';

describe('searchTerms', () => {
  it('drops question words (fusha, Saudi, English) and strips prefixes', () => {
    // و in وظيفة is part of the word: both forms are searched.
    expect(searchTerms('وش وظيفة الميتوكوندريا؟')).toEqual(['وظيفه', 'ظيفه', 'ميتوكوندريا']);
    expect(searchTerms('ما الفرق بين النقل النشط والنقل السلبي')).toEqual(['نقل', 'نشط', 'سلبي']);
    expect(searchTerms('What is the induced fit model?')).toEqual(['induced', 'fit', 'model']);
    expect(searchTerms('اشرح لي')).toEqual([]);
    expect(ftsQuery([])).toBeNull();
  });
});

describe('searchPages on real extracted text (course.pdf)', () => {
  let t: ReturnType<typeof makeTestApp>;
  let subjectId: number;
  let fileId: number;

  beforeEach(async () => {
    t = makeTestApp();
    subjectId = (await t.json('POST', '/api/subjects', { name: 'BIO' })).body.id;
    fileId = (await t.upload(subjectId, 'content', [{ name: 'course.pdf', data: fixture('course.pdf') }]))[0]!.fileId;
    await t.upload(subjectId, 'past_exam', [{ name: 'exam.pdf', data: fixture('exam2024.pdf') }]);
    await t.settle();
  });
  afterEach(() => t.cleanup());

  const pagesFor = (q: string, limit = 3) => searchPages(t.db, subjectId, searchTerms(q), limit).map((h) => h.page);

  it('finds the right page for Arabic questions despite prefixes, hamza and ta marbuta', () => {
    expect(pagesFor('وش وظيفة جهاز جولجي؟')[0]).toBe(4);
    expect(pagesFor('ما هو الببسين')[0]).toBe(7);
    expect(pagesFor('اشرح الخاصية الأسموزية')[0]).toBe(3);
    expect(pagesFor('ما هي نظرية الخلية')[0]).toBe(2);
  });

  it('finds English terms inside Arabic text', () => {
    expect(pagesFor('Induced fit')[0]).toBe(6);
    expect(pagesFor('Na pump')[0]).toBe(3);
  });

  it('searches content files only and respects page ranges', () => {
    // "Which of the following" appears only in the past exam.
    expect(searchPages(t.db, subjectId, searchTerms('Which following'), 5)).toEqual([]);
    const within = searchPages(t.db, subjectId, searchTerms('الإنزيم'), 10, [{ fileId, from: 6, to: 7 }]).map((h) => h.page);
    expect(within.sort()).toEqual([6, 7]);
  });

  it('returns nothing for topics not in the files', () => {
    expect(pagesFor('الكلوروبلاست والبناء الضوئي')).toEqual([]);
  });
});
