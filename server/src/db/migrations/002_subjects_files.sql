-- Phase 2: subjects, exams, uploaded files, extracted pages, full-text index.

CREATE TABLE subjects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 1,
  name        TEXT    NOT NULL,
  doctor      TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Exam scope (which chapters) is added in phase 3 together with chapters.
CREATE TABLE exams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  exam_date   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX exams_subject ON exams(subject_id);

CREATE TABLE files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 1,
  subject_id   INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL CHECK (kind IN ('content','past_exam')),
  name         TEXT    NOT NULL,             -- original file name
  stored_path  TEXT    NOT NULL,             -- relative to data/uploads
  mime         TEXT    NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT    NOT NULL,
  page_count   INTEGER,
  status       TEXT    NOT NULL CHECK (status IN ('processing','ocr','ready','partial','failed')),
  error        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (subject_id, sha256)
);
CREATE INDEX files_subject ON files(subject_id);

-- One row per page. text = readable text for display and prompts; text_norm = search form.
CREATE TABLE pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  page_no     INTEGER NOT NULL,
  text        TEXT    NOT NULL DEFAULT '',
  text_norm   TEXT    NOT NULL DEFAULT '',
  source      TEXT    CHECK (source IN ('direct','ai')),
  status      TEXT    NOT NULL CHECK (status IN ('ok','pending_ocr','ocr_failed')),
  ai_note     TEXT,                          -- e.g. low-confidence notes from AI reading
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (file_id, page_no)
);

-- External-content FTS5 index over pages.text_norm, kept in sync by triggers.
CREATE VIRTUAL TABLE pages_fts USING fts5(
  text_norm,
  content = 'pages',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, text_norm) VALUES (new.id, new.text_norm);
END;
CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, text_norm) VALUES ('delete', old.id, old.text_norm);
END;
CREATE TRIGGER pages_au AFTER UPDATE OF text_norm ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, text_norm) VALUES ('delete', old.id, old.text_norm);
  INSERT INTO pages_fts(rowid, text_norm) VALUES (new.id, new.text_norm);
END;
