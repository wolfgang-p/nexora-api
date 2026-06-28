-- =============================================================================
-- Koro — Migration tracking
-- =============================================================================
-- Records which migration files have been applied, so deploys are repeatable
-- and we never apply the same file twice or skip one. Managed by
-- scripts/migrate.js — you normally don't touch this table by hand.
--
-- `version` is the numeric prefix of the file (e.g. '0031'); `name` is the full
-- filename. `applied_at` and `checksum` let us detect a file that changed after
-- it was already applied (which would mean someone edited a shipped migration).
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
