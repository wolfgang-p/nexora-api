-- 0010_p5_moderation_admin.sql
-- ──────────────────────────────────────────────────────────────────────
-- Tables and columns required for P5.1–P5.6: moderation, compliance,
-- admin tooling, API-key scopes, feature flags, retention, webhook
-- dispatcher.
-- ──────────────────────────────────────────────────────────────────────

-- ── users: admin + ban metadata ─────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS banned_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banned_reason  TEXT,
  ADD COLUMN IF NOT EXISTS banned_by      UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_banned_at_idx ON users (banned_at) WHERE banned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_is_admin_idx   ON users (is_admin) WHERE is_admin = TRUE;

-- Bans survive device rotation: re-registration must look up phone_hash
-- AND device identity_public_key fingerprint. That's why 0008 added
-- phone_hash. We store banned fingerprints separately so the user record
-- can be deleted/anonymized while the fingerprint-ban persists.
CREATE TABLE IF NOT EXISTS banned_fingerprints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash      TEXT,
  device_public_key TEXT,
  reason          TEXT,
  banned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  banned_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Either one of phone_hash / device_public_key must be set.
  CHECK (phone_hash IS NOT NULL OR device_public_key IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS banned_fp_phone_idx  ON banned_fingerprints (phone_hash)  WHERE phone_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS banned_fp_pubkey_idx ON banned_fingerprints (device_public_key) WHERE device_public_key IS NOT NULL;

-- ── Abuse reports ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Exactly one target: message OR user (reporter can also supply both
  -- if the offence is a specific message FROM a specific user).
  target_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  target_user_id    UUID REFERENCES users(id)    ON DELETE SET NULL,
  target_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  reason          TEXT NOT NULL,          -- enum-ish: spam, harassment, csam, illegal, other
  details         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | reviewed | dismissed | actioned
  resolution      TEXT,                   -- free text set by admin
  resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (target_message_id IS NOT NULL OR target_user_id IS NOT NULL OR target_conversation_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS reports_status_idx  ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_target_user ON reports (target_user_id) WHERE target_user_id IS NOT NULL;

-- Appeals — user can contest a ban or a message removal.
CREATE TABLE IF NOT EXISTS report_appeals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_id       UUID REFERENCES reports(id) ON DELETE SET NULL,
  ban_ref         UUID, -- nullable, corresponds to banned_fingerprints.id if the appeal is about a ban
  message         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  admin_response  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS appeals_status_idx ON report_appeals (status, created_at DESC);

-- ── Feature flags ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  key             TEXT PRIMARY KEY,       -- e.g. "web.ai.autoscan", "mobile.calls.groupBeta"
  description     TEXT,
  -- rollout: 'off' | 'on' | 'percent' | 'workspace'
  rollout         TEXT NOT NULL DEFAULT 'off',
  percent         INTEGER,                -- 0-100 when rollout='percent'
  allow_workspaces UUID[] NOT NULL DEFAULT '{}',  -- when rollout='workspace'
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (rollout IN ('off','on','percent','workspace')),
  CHECK (percent IS NULL OR (percent BETWEEN 0 AND 100))
);

-- ── Retention policies (per workspace, or global fallback) ─────────
CREATE TABLE IF NOT EXISTS retention_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  -- NULL workspace + NULL conversation = global default.
  message_ttl_days  INTEGER,
  media_ttl_days    INTEGER,
  audit_ttl_days    INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, conversation_id)
);

-- ── Webhook dispatcher: events queue ───────────────────────────────
-- We already have webhook_deliveries + the retry worker from 0001.
-- Add a lightweight "recent events" ring for admin-UI introspection.
-- This is NOT the primary delivery path — deliveries still go through
-- webhook_deliveries. This is a short-lived mirror capped by retention.
CREATE TABLE IF NOT EXISTS webhook_event_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event           TEXT NOT NULL,
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_event_log_recent
  ON webhook_event_log (created_at DESC);

-- Retention cleanup for this table is done by the scheduler (see server-
-- side logic). 30 days default.

-- ── Spam detection scratchpad ──────────────────────────────────────
-- SimHash of each message body (computed server-side from the *length*
-- and nth-char fingerprint since we never see plaintext). This catches
-- "same-size, same-pattern ciphertext fan-out" → spam signature. Real
-- content-based SimHash is only feasible on unencrypted traffic, so
-- this is a heuristic that gets us coarse deduplication at best.
CREATE TABLE IF NOT EXISTS spam_signatures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signature       TEXT NOT NULL,
  recipient_count INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spam_sig_sender_idx ON spam_signatures (sender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS spam_sig_hash_idx   ON spam_signatures (signature, created_at DESC);
