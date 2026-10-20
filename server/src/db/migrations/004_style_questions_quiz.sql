-- Phase 4: doctor's style profile, generated questions (with verification), reports, quizzes.

CREATE TABLE style_profiles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id     INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  file_ids_json  TEXT    NOT NULL,           -- past-exam files analyzed (to detect when new ones are added)
  profile_json   TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX style_profiles_subject ON style_profiles(subject_id, id);

-- One generation request. status: generating → verifying → ready | failed.
CREATE TABLE question_sets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL DEFAULT 1,
  subject_id     INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  chapter_ids_json TEXT  NOT NULL,
  qtype          TEXT    NOT NULL,           -- a question type or 'mixed'
  difficulty     TEXT    NOT NULL,           -- easy | medium | hard | mixed
  requested      INTEGER NOT NULL,
  style_id       INTEGER REFERENCES style_profiles(id) ON DELETE SET NULL,
  status         TEXT    NOT NULL CHECK (status IN ('generating','verifying','ready','failed')),
  error          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX question_sets_subject ON question_sets(subject_id, id);

-- status: pending (not verified yet — never shown) | active | rejected (failed verification) | reported (user flagged).
CREATE TABLE questions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL DEFAULT 1,
  subject_id     INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  set_id         INTEGER REFERENCES question_sets(id) ON DELETE CASCADE,
  chapter_id     INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  qtype          TEXT    NOT NULL CHECK (qtype IN ('mcq','true_false','short_answer','essay')),
  difficulty     TEXT    NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  stem           TEXT    NOT NULL,
  data_json      TEXT    NOT NULL,           -- options, answer, key points, per-option explanations
  explanation    TEXT    NOT NULL,
  refs_json      TEXT    NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('pending','active','rejected','reported')),
  status_note    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX questions_subject ON questions(subject_id, status);
CREATE INDEX questions_set ON questions(set_id);

CREATE TABLE question_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 1,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  note         TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE quiz_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL DEFAULT 1,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  time_limit_sec  INTEGER,                   -- NULL = untimed
  started_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at     TEXT
);

CREATE TABLE quiz_items (
  session_id   INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  PRIMARY KEY (session_id, question_id)
);

-- One attempt per quiz item. score is 0..1; essays are graded by AI (status grading → graded | failed).
CREATE TABLE attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL DEFAULT 1,
  session_id    INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer_json   TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('grading','graded','failed')),
  score         REAL,
  feedback_json TEXT,
  error         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (session_id, question_id)
);
CREATE INDEX attempts_question ON attempts(question_id);
