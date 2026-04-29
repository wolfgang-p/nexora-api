-- 0020_calendar_tasks_drive.sql
-- Bundle of schema additions for the Calendar / Tasks / Drive batch:
--   • calendar_events: recurrence (RRULE), workspace scope, ends_at default
--   • tasks:           parent_id (subtasks), recurrence (RRULE)
--   • task_time_entries: timer rows for time-tracking
--   • workspace_files:  parent_folder_id (folders), version + group_id
--                       (versioning — last 5 per filename)
-- All idempotent.

-- ── Calendar ──────────────────────────────────────────────────────────────
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS recurrence  TEXT,
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

-- A workspace event is visible to every member of that workspace, regardless
-- of `user_id`. Index for the listing query.
CREATE INDEX IF NOT EXISTS calendar_events_workspace_idx
  ON calendar_events (workspace_id, starts_at DESC)
  WHERE workspace_id IS NOT NULL;

-- ── Tasks ─────────────────────────────────────────────────────────────────
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_id   UUID REFERENCES tasks(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS recurrence  TEXT;

CREATE INDEX IF NOT EXISTS tasks_parent_idx
  ON tasks (parent_id, created_at)
  WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_time_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS task_time_entries_task_idx
  ON task_time_entries (task_id, started_at DESC);
-- Only one open (ended_at IS NULL) entry per (user, task) at a time —
-- prevents accidental double-starts.
CREATE UNIQUE INDEX IF NOT EXISTS task_time_entries_open_uq
  ON task_time_entries (user_id, task_id)
  WHERE ended_at IS NULL;

-- ── Drive (workspace_files) ──────────────────────────────────────────────
-- Folders: a self-FK on workspace_files. A row with `is_folder = true` and
-- no `media_object_id` is a folder; otherwise it's a file. We didn't
-- separate folders into their own table — keeps the list endpoint simple.
ALTER TABLE workspace_files
  ADD COLUMN IF NOT EXISTS parent_folder_id UUID REFERENCES workspace_files(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS is_folder        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Versioning: every upload of the same `name` inside the same parent
  -- shares a `version_group_id`. The active row is the highest `version`.
  -- Older rows stay around for the history popup; we cap at the 5
  -- newest per group via a trigger / sweeper.
  ADD COLUMN IF NOT EXISTS version          INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS version_group_id UUID;

-- Make media_object_id optional now (folders don't have media).
ALTER TABLE workspace_files
  ALTER COLUMN media_object_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS workspace_files_parent_idx
  ON workspace_files (workspace_id, parent_folder_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_files_version_group_idx
  ON workspace_files (version_group_id, version DESC)
  WHERE deleted_at IS NULL AND version_group_id IS NOT NULL;
