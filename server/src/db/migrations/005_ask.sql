-- Phase 5: «اسأل المادة» — threads of questions answered from the user's files only.

CREATE TABLE ask_threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 1,
  subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ask_threads_subject ON ask_threads(subject_id, id);

-- status: searching (query expansion) → answering → done | failed.
-- retrieval: how pages were chosen — scope (chapter/topic pages), search (FTS), search+expand (FTS after AI keywords).
CREATE TABLE asks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 1,
  thread_id    INTEGER NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  question     TEXT    NOT NULL,
  scope_json   TEXT    NOT NULL,
  dialect      TEXT    NOT NULL CHECK (dialect IN ('fusha','saudi')),
  status       TEXT    NOT NULL CHECK (status IN ('searching','answering','done','failed')),
  retrieval    TEXT,
  pages_json   TEXT,
  result_json  TEXT,
  error        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX asks_thread ON asks(thread_id, id);
