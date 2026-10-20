-- Phase 1: AI job log and settings. Later phases add their own migrations.
-- user_id on every user-owned table (single user = 1 for now).

CREATE TABLE ai_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 1,
  kind         TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  ref_type     TEXT,
  ref_id       INTEGER,
  model        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  input_json   TEXT,
  result_json  TEXT,
  error_code   TEXT,
  error        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at   TEXT,
  finished_at  TEXT,
  duration_ms  INTEGER
);
CREATE INDEX ai_jobs_status ON ai_jobs(status);
CREATE INDEX ai_jobs_ref ON ai_jobs(ref_type, ref_id);

CREATE TABLE settings (
  user_id  INTEGER NOT NULL DEFAULT 1,
  key      TEXT    NOT NULL,
  value    TEXT    NOT NULL,
  PRIMARY KEY (user_id, key)
);
