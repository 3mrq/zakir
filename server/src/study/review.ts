// Mistake log + spaced repetition (Leitner, 5 boxes) + weaknesses by chapter and topic.
//
// Every wrong answer (score < 0.8) creates or resets a card to box 1, due tomorrow. In a review session:
//   score ≥ 0.8 → next box (due after LEITNER_DAYS[box]); right in box 5 → mastered (leaves the queue)
//   score ≤ 0.4 → back to box 1, due tomorrow
//   otherwise   → same box, due tomorrow
// A right answer in a normal quiz moves a card only if it was due (no promotion by cramming).

import type { AttemptDTO, CardState, MistakeDTO, PageRef, ReviewSubjectDTO, WeaknessesDTO, WeaknessRow } from '@zakir/shared';
import { LEITNER_DAYS } from '@zakir/shared';
import type { DB } from '../db/index.ts';
import { questionToDTO, type QuestionRow } from './questions.ts';

export const CORRECT = 0.8;
const WRONG = 0.4;
const MIN_ATTEMPTS = 2;

/** Local calendar date YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Pure Leitner step. */
export function schedule(box: number, score: number, today: string): { box: number; dueOn: string; mastered: boolean; lapse: boolean } {
  if (score >= CORRECT) {
    if (box >= 5) return { box: 5, dueOn: addDays(today, LEITNER_DAYS[5]), mastered: true, lapse: false };
    return { box: box + 1, dueOn: addDays(today, LEITNER_DAYS[box + 1]!), mastered: false, lapse: false };
  }
  if (score <= WRONG) return { box: 1, dueOn: addDays(today, 1), mastered: false, lapse: true };
  return { box, dueOn: addDays(today, 1), mastered: false, lapse: false };
}

interface CardRow {
  id: number;
  question_id: number;
  box: number;
  due_on: string;
  mastered: number;
  lapses: number;
}

const toState = (c: CardRow): CardState => ({ box: c.box, dueOn: c.due_on, mastered: !!c.mastered });

export class ReviewService {
  constructor(
    private readonly db: DB,
    private readonly today: () => string = () => localToday(),
  ) {}

  private card(questionId: number) {
    return this.db.prepare(`SELECT * FROM review_cards WHERE question_id = ?`).get(questionId) as CardRow | undefined;
  }

  cardState(questionId: number): CardState | null {
    const c = this.card(questionId);
    return c ? toState(c) : null;
  }

  /** Called whenever an answer gets its final score. */
  record(questionId: number, score: number, source: 'quiz' | 'review') {
    const today = this.today();
    const c = this.card(questionId);
    const log = (cardId: number, before: number | null, after: number) =>
      this.db.prepare(`INSERT INTO review_log (card_id, source, score, box_before, box_after, reviewed_on) VALUES (?, ?, ?, ?, ?, ?)`).run(cardId, source, score, before, after, today);

    if (!c) {
      if (score >= CORRECT) return; // nothing to remember
      const id = Number(
        this.db.prepare(`INSERT INTO review_cards (question_id, box, due_on, lapses, last_reviewed_on) VALUES (?, 1, ?, 1, ?)`).run(questionId, addDays(today, 1), today)
          .lastInsertRowid,
      );
      return log(id, null, 1);
    }
    const due = !c.mastered && c.due_on <= today;
    // In a normal quiz a right answer only counts when the card was due; a wrong one always counts.
    if (source === 'quiz' && score >= CORRECT && !due) return;
    const next = c.mastered && score < CORRECT ? schedule(1, 0, today) : schedule(c.box, score, today);
    this.db
      .prepare(`UPDATE review_cards SET box = ?, due_on = ?, mastered = ?, lapses = lapses + ?, last_reviewed_on = ? WHERE id = ?`)
      .run(next.box, next.dueOn, next.mastered ? 1 : 0, next.lapse ? 1 : 0, today, c.id);
    log(c.id, c.box, next.box);
  }

  /** Due cards of a subject (verified questions only), most-forgotten first. */
  dueQuestionIds(subjectId: number, limit = 30): number[] {
    return (
      this.db
        .prepare(
          `SELECT c.question_id id FROM review_cards c JOIN questions q ON q.id = c.question_id
           WHERE q.subject_id = ? AND q.status = 'active' AND c.mastered = 0 AND c.due_on <= ?
           ORDER BY c.box, c.due_on, c.lapses DESC LIMIT ?`,
        )
        .all(subjectId, this.today(), limit) as { id: number }[]
    ).map((r) => r.id);
  }

  summary(): ReviewSubjectDTO[] {
    const today = this.today();
    const subjects = this.db.prepare(`SELECT id, name FROM subjects ORDER BY id`).all() as { id: number; name: string }[];
    return subjects.map((s) => {
      const cards = this.db
        .prepare(`SELECT c.box, c.due_on, c.mastered FROM review_cards c JOIN questions q ON q.id = c.question_id WHERE q.subject_id = ? AND q.status = 'active'`)
        .all(s.id) as { box: number; due_on: string; mastered: number }[];
      const active = cards.filter((c) => !c.mastered);
      const upcoming = active.filter((c) => c.due_on > today).map((c) => c.due_on).sort();
      return {
        subjectId: s.id,
        name: s.name,
        due: active.filter((c) => c.due_on <= today).length,
        learning: active.length,
        mastered: cards.length - active.length,
        nextDueOn: upcoming[0] ?? null,
        boxes: [1, 2, 3, 4, 5].map((b) => active.filter((c) => c.box === b).length),
      };
    });
  }

  // ---------- mistakes & weaknesses ----------

  mistakes(subjectId: number, limit = 100): MistakeDTO[] {
    const rows = this.db
      .prepare(
        `SELECT a.id attempt_id, a.session_id, a.created_at a_created, a.score, a.answer_json, a.feedback_json, a.status a_status, a.error,
                q.*, ch.title chapter_title
         FROM attempts a JOIN questions q ON q.id = a.question_id LEFT JOIN chapters ch ON ch.id = q.chapter_id
         WHERE q.subject_id = ? AND a.status = 'graded' AND a.score < ?
         ORDER BY a.id DESC LIMIT ?`,
      )
      .all(subjectId, CORRECT, limit) as (QuestionRow & {
      attempt_id: number;
      session_id: number;
      a_created: string;
      score: number;
      answer_json: string;
      feedback_json: string | null;
      a_status: AttemptDTO['status'];
      error: string | null;
      chapter_title: string | null;
    })[];
    return rows.map((r) => ({
      attemptId: r.attempt_id,
      quizId: r.session_id,
      createdAt: r.a_created,
      score: r.score,
      chapterTitle: r.chapter_title,
      question: questionToDTO(r, true),
      attempt: { answer: JSON.parse(r.answer_json), status: r.a_status, score: r.score, feedback: r.feedback_json ? JSON.parse(r.feedback_json) : null, error: r.error },
      card: this.cardState(r.id),
    }));
  }

  weaknesses(subjectId: number): WeaknessesDTO {
    const attempts = this.db
      .prepare(
        `SELECT a.question_id qid, a.score, q.chapter_id, q.refs_json FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE q.subject_id = ? AND a.status = 'graded' AND q.status != 'rejected'`,
      )
      .all(subjectId) as { qid: number; score: number; chapter_id: number | null; refs_json: string }[];
    const open = new Set(
      (
        this.db
          .prepare(`SELECT c.question_id FROM review_cards c JOIN questions q ON q.id = c.question_id WHERE q.subject_id = ? AND c.mastered = 0`)
          .all(subjectId) as { question_id: number }[]
      ).map((r) => r.question_id),
    );
    const chapters = this.db.prepare(`SELECT id, title FROM chapters WHERE subject_id = ? ORDER BY ord`).all(subjectId) as { id: number; title: string }[];
    const topics = this.db
      .prepare(
        `SELECT t.id, t.title, t.chapter_id, t.file_id, t.page_from, t.page_to FROM topics t JOIN chapters c ON c.id = t.chapter_id
         WHERE c.subject_id = ? ORDER BY c.ord, t.ord`,
      )
      .all(subjectId) as { id: number; title: string; chapter_id: number; file_id: number; page_from: number; page_to: number }[];

    type Acc = { sum: number; n: number; wrong: number; qids: Set<number> };
    const acc = () => ({ sum: 0, n: 0, wrong: 0, qids: new Set<number>() });
    const add = (a: Acc, score: number, qid: number) => {
      a.sum += score;
      a.n++;
      if (score < CORRECT) a.wrong++;
      a.qids.add(qid);
    };
    const byChapter = new Map<number, Acc>();
    const byTopic = new Map<number, Acc>();
    for (const at of attempts) {
      if (at.chapter_id) add(byChapter.get(at.chapter_id) ?? byChapter.set(at.chapter_id, acc()).get(at.chapter_id)!, at.score, at.qid);
      // A question belongs to every topic one of its source pages falls in.
      const refs = JSON.parse(at.refs_json) as PageRef[];
      for (const t of topics) {
        if (refs.some((r) => r.fileId === t.file_id && r.page >= t.page_from && r.page <= t.page_to)) {
          add(byTopic.get(t.id) ?? byTopic.set(t.id, acc()).get(t.id)!, at.score, at.qid);
        }
      }
    }
    const row = (key: string, title: string, chapterId: number | null, a: Acc | undefined, range?: WeaknessRow['range']): WeaknessRow => ({
      key,
      title,
      chapterId,
      range,
      attempts: a?.n ?? 0,
      accuracy: a && a.n ? Math.round((a.sum / a.n) * 100) / 100 : 0,
      wrong: a?.wrong ?? 0,
      openCards: a ? [...a.qids].filter((q) => open.has(q)).length : 0,
    });
    // Judged rows (enough attempts) weakest first, then the rest; untouched ones last.
    const order = (a: WeaknessRow, b: WeaknessRow) => {
      const ja = a.attempts >= MIN_ATTEMPTS ? 0 : a.attempts ? 1 : 2;
      const jb = b.attempts >= MIN_ATTEMPTS ? 0 : b.attempts ? 1 : 2;
      return ja - jb || a.accuracy - b.accuracy || b.attempts - a.attempts;
    };
    return {
      chapters: chapters.map((c) => row(`c${c.id}`, c.title, c.id, byChapter.get(c.id))).sort(order),
      topics: topics.map((t) => row(`t${t.id}`, t.title, t.chapter_id, byTopic.get(t.id), { fileId: t.file_id, from: t.page_from, to: t.page_to })).sort(order),
      minAttempts: MIN_ATTEMPTS,
    };
  }
}
