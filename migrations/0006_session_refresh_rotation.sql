-- Refresh-token rotation with theft detection.
--
-- Every time /auth/refresh is called we mint a new refresh token and
-- insert a NEW sessions row for it. The old row stays around with
-- `rotated_at` set so we can detect reuse: if somebody presents a
-- refresh token whose row already has `rotated_at`, that token was
-- replaced long ago — someone must be replaying a copy. We revoke the
-- entire user to shut out the attacker.
--
-- Old rotated rows are pruned lazily after ROTATION_GRACE_DAYS in the
-- refresh handler (default 7d). Rows with revoked_at IS NULL and
-- rotated_at IS NULL are the currently-valid ones.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;

-- Fast lookup by hash — required for theft detection across rotated rows.
CREATE INDEX IF NOT EXISTS sessions_refresh_hash_idx
  ON sessions (refresh_token_hash);

-- Active sessions per device (for listing/logout). Only rows that
-- haven't been rotated or revoked.
CREATE INDEX IF NOT EXISTS sessions_device_live_idx
  ON sessions (device_id)
  WHERE revoked_at IS NULL AND rotated_at IS NULL;
