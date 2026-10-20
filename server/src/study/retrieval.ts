// Local page retrieval over the normalized FTS5 index — no AI call, no quota.
// The question is normalized like the indexed text (normalize.ts), stop words dropped, prefixes stripped,
// and every remaining word is searched as a prefix, ranked with bm25.

import type { DB } from '../db/index.ts';
import { normalizeArabic, stripPrefix } from '../ingest/normalize.ts';

const STOP = new Set(
  [
    // Arabic (fusha + common Saudi question words), normalized form
    'من', 'في', 'على', 'الي', 'الى', 'عن', 'ما', 'ماذا', 'هل', 'كيف', 'لماذا', 'ليش', 'وش', 'ايش', 'متي', 'اين', 'وين', 'هو', 'هي', 'هم',
    'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'الذين', 'او', 'ثم', 'مع', 'كل', 'بين', 'عند', 'لي', 'لك', 'انا', 'انت', 'يعني', 'اشرح',
    'اشرحلي', 'وضح', 'وضحلي', 'فسر', 'عرف', 'اذكر', 'قارن', 'الفرق', 'فرق', 'هناك', 'ايه', 'شو', 'كم', 'قد', 'لا', 'ان', 'لم', 'لن', 'كان',
    'يكون', 'تكون', 'بعض', 'اي', 'غير', 'حول', 'عليه', 'فيه', 'منه', 'به', 'له', 'لها', 'معني', 'مفهوم', 'تعريف', 'شرح',
    // English
    'what', 'is', 'are', 'the', 'of', 'a', 'an', 'and', 'or', 'in', 'on', 'to', 'how', 'why', 'does', 'do', 'which', 'explain', 'define',
    'difference', 'between', 'about', 'with', 'for', 'by', 'it', 'its', 'this', 'that', 'be', 'can', 'me', 'tell', 'describe', 'compare',
  ].map(normalizeArabic),
);

/**
 * Search terms for a question: normalized, stop words removed, deduplicated. For Arabic words both the
 * word and its prefix-stripped stem are kept, because a leading و/ب/ل may be part of the word (وظيفة).
 */
export function searchTerms(text: string): string[] {
  const out = new Set<string>();
  for (const w of normalizeArabic(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOP.has(w) || w.length < 2) continue;
    const stem = /[ء-ي]/.test(w) ? stripPrefix(w) : w;
    if (STOP.has(stem)) continue;
    // "ال" + word: the stem is enough (the indexed text holds stems too); other prefixes: keep both.
    if (stem !== w && !/^[وفبكل]?(ال|لل)/.test(w)) out.add(w);
    if (stem.length >= 2) out.add(stem);
  }
  return [...out];
}

/** FTS5 query: any term, each as a prefix ("خليه"* also matches خليه/خليتين...). */
export function ftsQuery(terms: string[]): string | null {
  return terms.length ? terms.map((t) => `"${t}"*`).join(' OR ') : null;
}

/** Share of terms that appear somewhere in the subject's content pages (0..1). */
export function termCoverage(db: DB, subjectId: number, terms: string[]): number {
  if (!terms.length) return 0;
  const stmt = db.prepare(
    `SELECT 1 FROM pages_fts f JOIN pages p ON p.id = f.rowid JOIN files fl ON fl.id = p.file_id
     WHERE pages_fts MATCH ? AND fl.subject_id = ? AND fl.kind = 'content' LIMIT 1`,
  );
  return terms.filter((t) => stmt.get(`"${t}"*`, subjectId)).length / terms.length;
}

export interface Hit {
  fileId: number;
  page: number;
  text: string;
}

/**
 * Top pages of the subject's content files for the given terms. `within` restricts to page ranges
 * (used when a chapter is too large to send whole).
 */
export function searchPages(
  db: DB,
  subjectId: number,
  terms: string[],
  limit: number,
  within?: { fileId: number; from: number; to: number }[],
): Hit[] {
  const q = ftsQuery(terms);
  if (!q) return [];
  const rangeSql = within?.length ? `AND (${within.map(() => '(p.file_id = ? AND p.page_no BETWEEN ? AND ?)').join(' OR ')})` : '';
  const rangeArgs = within?.flatMap((r) => [r.fileId, r.from, r.to]) ?? [];
  return db
    .prepare(
      `SELECT p.file_id fileId, p.page_no page, p.text FROM pages_fts f
       JOIN pages p ON p.id = f.rowid
       JOIN files fl ON fl.id = p.file_id
       WHERE pages_fts MATCH ? AND fl.subject_id = ? AND fl.kind = 'content' AND p.status = 'ok' AND p.text != '' ${rangeSql}
       ORDER BY bm25(pages_fts) LIMIT ?`,
    )
    .all(q, subjectId, ...rangeArgs, limit) as Hit[];
}
