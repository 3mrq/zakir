-- Phase 7: study plan per exam. The schedule itself is recomputed from current state on every read
-- (that is how it adapts to delays and weaknesses); only settings and task outcomes are stored.

CREATE TABLE exam_plans (
  exam_id           INTEGER PRIMARY KEY REFERENCES exams(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL DEFAULT 1,
  daily_minutes     INTEGER NOT NULL CHECK (daily_minutes BETWEEN 15 AND 900),
  off_days_json     TEXT    NOT NULL DEFAULT '[]',   -- weekdays with no study, 0 = Sunday … 6 = Saturday
  minutes_per_page  REAL    NOT NULL DEFAULT 4,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Outcome of each task (by stable key, e.g. "study:12:1"). first_planned_on = the first day the task was
-- scheduled, so a task still pending after that day is shown as delayed.
CREATE TABLE plan_task_state (
  exam_id          INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  task_key         TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('pending','done','skipped')),
  first_planned_on TEXT,
  done_on          TEXT,
  auto             INTEGER NOT NULL DEFAULT 0,       -- completed automatically (e.g. enough practice answers)
  PRIMARY KEY (exam_id, task_key)
);
