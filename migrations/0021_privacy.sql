-- 0021_privacy.sql
-- Per-user privacy toggles:
--   • show_last_seen — hides last_seen_at from /users/:id when off

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS show_last_seen BOOLEAN NOT NULL DEFAULT TRUE;
