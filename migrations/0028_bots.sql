-- 0028_bots.sql
-- Named bots — a developer-facing programmatic identity.
--
-- A bot is a real `users` row (is_bot = true) so its display_name + avatar
-- show up correctly in EVERY existing client (chat, search, member lists)
-- with no client changes — sender names are resolved client-side from
-- users.display_name, and the message API never joined a name anyway.
--
-- A bot has:
--   • a users row (is_bot = true, no phone, with display_name/username/avatar
--     + identity_public_key)
--   • an api_bot devices row (its E2E device identity; the SECRET key is
--     generated in the browser and never reaches the server)
--   • a bots row (workspace + owner + api_key linkage / management metadata)
--   • an api_keys row with crm_device_id pointing at the bot device, so the
--     key authenticates AS the bot (see src/api_keys/middleware.js bridge).
--
-- All idempotent.

-- ── users: allow bot rows ──────────────────────────────────────────────────
-- Humans still go through phone OTP at the app layer; we only relax the DB
-- constraint so a bot (which has no phone) can exist. UNIQUE on a nullable
-- column allows multiple NULLs in Postgres, so bots don't collide.
ALTER TABLE users ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS users_is_bot_idx ON users (id) WHERE is_bot;

-- ── bots: management metadata, one row per bot ─────────────────────────────
CREATE TABLE IF NOT EXISTS bots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,   -- the bot identity
  device_id       UUID REFERENCES devices(id) ON DELETE SET NULL,                -- the bot's E2E device
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  api_key_id      UUID REFERENCES api_keys(id) ON DELETE SET NULL,               -- current active key
  created_by_user UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bots_workspace_idx
  ON bots (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- ── RLS (defense-in-depth; service-role bypasses, handlers enforce) ────────
ALTER TABLE bots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bots_member_select ON bots;
CREATE POLICY bots_member_select ON bots
  FOR SELECT USING (deleted_at IS NULL AND koro.is_ws_member(workspace_id));

DROP POLICY IF EXISTS bots_admin_write ON bots;
CREATE POLICY bots_admin_write ON bots
  FOR ALL USING (koro.is_ws_admin(workspace_id))
          WITH CHECK (koro.is_ws_admin(workspace_id));
