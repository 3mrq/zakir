-- Phase 3: chapters (page ranges across content files), topics, summaries, exam scope.

-- Version of the local text extractor that produced a file's pages. When the extractor improves,
-- older files are re-extracted locally on startup (AI-read pages are kept, never re-sent).
ALTER TABLE files ADD COLUMN extract_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE chapters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  ord             INTEGER NOT NULL,
  auto_generated  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX chapters_subject ON chapters(subject_id, ord);

-- A chapter is one or more page ranges, possibly across several files.
CREATE TABLE chapter_ranges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  page_from   INTEGER NOT NULL,
  page_to     INTEGER NOT NULL,
  ord         INTEGER NOT NULL,
  CHECK (page_from >= 1 AND page_to >= page_from)
);
CREATE INDEX chapter_ranges_chapter ON chapter_ranges(chapter_id);
CREATE INDEX chapter_ranges_file ON chapter_ranges(file_id);

CREATE TABLE topics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  page_from   INTEGER NOT NULL,
  page_to     INTEGER NOT NULL,
  ord         INTEGER NOT NULL,
  CHECK (page_from >= 1 AND page_to >= page_from)
);
CREATE INDEX topics_chapter ON topics(chapter_id);

-- One summary per chapter holding both levels. source_hash = hash of the chapter's page texts
-- when generated; if the chapter changes, the summary is shown as outdated.
CREATE TABLE summaries (
  chapter_id     INTEGER PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  quick_json     TEXT    NOT NULL,
  detailed_json  TEXT    NOT NULL,
  source_hash    TEXT    NOT NULL,
  model          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE exam_scope (
  exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  PRIMARY KEY (exam_id, chapter_id)
);
