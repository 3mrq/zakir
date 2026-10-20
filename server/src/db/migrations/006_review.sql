-- Phase 6: mistake log + spaced repetition (Leitner, 5 boxes).

-- One card per question that was ever answered wrong. due_on is a local date (YYYY-MM-DD).
-- mastered = answered right in box 5; the card leaves the review queue until the next mistake.
CREATE TABLE review_cards (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL DEFAULT 1,
  question_id      INTEGER NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
  box              INTEGER NOT NULL CHECK (box BETWEEN 1 AND 5),
  due_on           TEXT    NOT NULL,
  mastered         INTEGER NOT NULL DEFAULT 0,
  lapses           INTEGER NOT NULL DEFAULT 0,
  last_reviewed_on TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX review_cards_due ON review_cards(mastered, due_on);

CREATE TABLE review_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL REFERENCES review_cards(id) ON DELETE CASCADE,
  source      TEXT    NOT NULL CHECK (source IN ('quiz','review')),
  score       REAL    NOT NULL,
  box_before  INTEGER,
  box_after   INTEGER NOT NULL,
  reviewed_on TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX review_log_card ON review_log(card_id);

-- practice = normal quiz; review = built from due cards (answers move cards between boxes).
ALTER TABLE quiz_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'practice' CHECK (kind IN ('practice','review'));

-- Mistakes made before this phase become cards due today.
INSERT INTO review_cards (question_id, box, due_on, lapses)
SELECT a.question_id, 1, date('now','localtime'), COUNT(*)
FROM attempts a JOIN questions q ON q.id = a.question_id
WHERE a.status = 'graded' AND a.score < 0.8 AND q.status = 'active'
GROUP BY a.question_id;
