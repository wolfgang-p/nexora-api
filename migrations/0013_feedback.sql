-- 0013_feedback.sql
-- General-purpose user feedback — separate from the `reports` table
-- (which models targeted abuse reports against a specific user/message).
-- Feedback captures feature requests, bug reports, praise, and "other"
-- — with an optional screenshot.

CREATE TABLE IF NOT EXISTS feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  -- enum-ish: 'bug', 'feature', 'praise', 'ux', 'security', 'other'
  body            TEXT NOT NULL,
  screenshot_media_id UUID REFERENCES media_objects(id) ON DELETE SET NULL,
  platform        TEXT,
  app_version     TEXT,
  status          TEXT NOT NULL DEFAULT 'new',
  -- enum-ish: 'new', 'triaged', 'resolved', 'wontfix'
  resolution_note TEXT,
  resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_status_idx
  ON feedback (status, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_user_idx
  ON feedback (user_id, created_at DESC);
