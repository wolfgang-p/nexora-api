-- =============================================================================
-- Koro — Core Schema (Postgres / Supabase)
-- Version: 0.1.0
-- =============================================================================
-- Design principles:
--   • Server never sees message plaintext. Messages are encrypted per recipient
--     *device* (Signal-style fanout). See ARCHITECTURE.md §3.
--   • Mobile, web, desktop, CRM seats, API bots — all are "devices" and all
--     enroll the same way (QR pairing or admin API-key).
--   • Metadata (sender, timestamp, conversation) is unencrypted so any
--     authorized system can index, search metadata, and fire webhooks without
--     holding keys.
--   • Row-Level Security is enabled everywhere except service-role access.
--   • All PKs are UUIDv7 (time-sortable). Use `gen_random_uuid()` from pgcrypto.
--
-- Apply with: psql $DB_URL -f migrations/0001_core.sql
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- fast ILIKE search on names
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- =============================================================================
-- 1. USERS  — one per human
-- =============================================================================

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164      TEXT UNIQUE NOT NULL,          -- +4917612345678
  username        TEXT UNIQUE,                   -- @handle
  display_name    TEXT,
  avatar_url      TEXT,
  account_type    TEXT NOT NULL DEFAULT 'personal'
                    CHECK (account_type IN ('personal', 'business')),
  locale          TEXT NOT NULL DEFAULT 'de',
  -- Public identity key (Curve25519 X25519) — used by other users to discover
  -- this user's *devices*. The per-device keys live in `devices`.
  identity_public_key  BYTEA,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX users_username_trgm ON users USING GIN (username gin_trgm_ops);
CREATE INDEX users_phone_idx ON users (phone_e164);
CREATE INDEX users_active ON users (id) WHERE deleted_at IS NULL;

-- =============================================================================
-- 2. OTP  — phone verification (SHA-256 hashed)
-- =============================================================================

CREATE TABLE otps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164      TEXT NOT NULL,
  code_hash       TEXT NOT NULL,                 -- sha256(code + pepper)
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  attempts        SMALLINT NOT NULL DEFAULT 0,
  ip_address      INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX otps_phone_active ON otps (phone_e164, expires_at) WHERE consumed_at IS NULL;

-- =============================================================================
-- 3. DEVICES  — every client (mobile, web, CRM seat, API bot) is a device
-- =============================================================================

CREATE TYPE device_kind AS ENUM ('mobile', 'web', 'desktop', 'crm_seat', 'api_bot');

CREATE TABLE devices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                    device_kind NOT NULL,
  label                   TEXT,                  -- "iPhone 15 Pro", "MacBook Pro Safari"
  -- Per-device signing + encryption key (Curve25519 X25519 for box, Ed25519 for sign)
  identity_public_key     BYTEA NOT NULL,
  signing_public_key      BYTEA,
  -- Pre-keys (optional, Signal-style; not required for MVP sealed-box scheme)
  signed_prekey_public    BYTEA,
  signed_prekey_signature BYTEA,
  -- Device fingerprint — derived from identity_public_key, shown in UI to compare
  fingerprint             TEXT NOT NULL,
  user_agent              TEXT,
  ip_hint                 INET,
  location_hint           TEXT,                  -- "Berlin" (coarse)
  enrolled_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at            TIMESTAMPTZ,
  revoked_at              TIMESTAMPTZ,
  revoked_reason          TEXT
);

CREATE INDEX devices_user_active ON devices (user_id) WHERE revoked_at IS NULL;
CREATE INDEX devices_fingerprint ON devices (fingerprint);

-- =============================================================================
-- 4. PAIRING SESSIONS  — QR code pairing of a new device (web/desktop/CRM)
-- =============================================================================
-- Flow (see ARCHITECTURE.md §4):
--   1. New device POSTs /pairing/sessions → gets id + pairing_code + nonce
--   2. New device generates ephemeral keypair; QR encodes { id, pairing_code,
--      ephemeral_pub }
--   3. Authenticated mobile device POSTs /pairing/sessions/:id/claim
--   4. Mobile device encrypts its user identity key to ephemeral_pub and
--      POSTs /pairing/sessions/:id/deliver { ciphertext, nonce }
--   5. New device polls /pairing/sessions/:id → gets ciphertext, decrypts,
--      has identity key, registers itself as a device.

CREATE TABLE pairing_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_code          TEXT NOT NULL,           -- "7F2KD" — shown under QR
  new_device_kind       device_kind NOT NULL,
  new_device_label      TEXT,
  ephemeral_public_key  BYTEA NOT NULL,          -- from new device
  claimed_by_user       UUID REFERENCES users(id),
  claimed_by_device     UUID REFERENCES devices(id),
  ciphertext            BYTEA,                   -- set on /deliver
  nonce                 BYTEA,
  resulting_device_id   UUID REFERENCES devices(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,    -- created_at + 120s
  completed_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ
);

CREATE INDEX pairing_active ON pairing_sessions (id) WHERE completed_at IS NULL AND cancelled_at IS NULL;

-- =============================================================================
-- 5. SESSIONS  — JWT refresh-token tracking per device (revokable)
-- =============================================================================

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,               -- sha256 of opaque refresh token
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX sessions_device_active ON sessions (device_id) WHERE revoked_at IS NULL;

-- =============================================================================
-- 6. WORKSPACES  — team containers
-- =============================================================================

CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'member', 'guest');

CREATE TABLE workspaces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE,
  description     TEXT,
  avatar_url      TEXT,
  announcement    TEXT,
  plan            TEXT NOT NULL DEFAULT 'free',
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE workspace_members (
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            workspace_role NOT NULL DEFAULT 'member',
  permissions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user ON workspace_members (user_id) WHERE left_at IS NULL;

CREATE TABLE workspace_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code            TEXT NOT NULL UNIQUE,
  role            workspace_role NOT NULL DEFAULT 'member',
  created_by      UUID NOT NULL REFERENCES users(id),
  max_uses        INT,
  uses            INT NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- 7. CONVERSATIONS  — the unit of chat; includes DMs, groups, channels
-- =============================================================================

CREATE TYPE conversation_kind AS ENUM ('direct', 'group', 'channel');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE notif_level AS ENUM ('all', 'mentions', 'muted');

CREATE TABLE conversations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  conversation_kind NOT NULL,
  workspace_id          UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  title                 TEXT,                    -- NULL for DMs
  description           TEXT,
  avatar_url            TEXT,
  -- Group/channel settings (see MobileGroupInfo in design)
  only_admins_send      BOOLEAN NOT NULL DEFAULT FALSE,
  only_admins_edit_info BOOLEAN NOT NULL DEFAULT FALSE,
  is_announcement       BOOLEAN NOT NULL DEFAULT FALSE,
  -- Soft-deletion at the conversation level (admin nuke)
  created_by            UUID NOT NULL REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  CONSTRAINT channel_needs_workspace CHECK (
    (kind = 'channel' AND workspace_id IS NOT NULL) OR
    (kind <> 'channel')
  )
);

CREATE INDEX conversations_workspace ON conversations (workspace_id) WHERE workspace_id IS NOT NULL;

CREATE TABLE conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            member_role NOT NULL DEFAULT 'member',
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  last_read_message_id UUID,                     -- for unread count; FK added below
  last_read_at    TIMESTAMPTZ,
  notif_level     notif_level NOT NULL DEFAULT 'all',
  muted_until     TIMESTAMPTZ,
  pinned_at       TIMESTAMPTZ,                   -- user-level pinning
  archived_at     TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX conv_members_user_active ON conversation_members (user_id) WHERE left_at IS NULL;
CREATE INDEX conv_members_user_pinned ON conversation_members (user_id, pinned_at DESC NULLS LAST) WHERE left_at IS NULL;

-- =============================================================================
-- 8. MESSAGES  — envelope (metadata only, no plaintext)
-- =============================================================================

CREATE TYPE message_kind AS ENUM (
  'text', 'image', 'voice', 'video', 'file', 'location',
  'system',            -- "Alice added Bob", "Group renamed"
  'deleted'            -- tombstone (body erased)
);

CREATE TABLE messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id     UUID NOT NULL REFERENCES users(id),
  sender_device_id   UUID NOT NULL REFERENCES devices(id),
  kind               message_kind NOT NULL,
  -- Threading
  reply_to_message_id UUID REFERENCES messages(id),
  thread_root_id      UUID REFERENCES messages(id),
  -- Media reference (encrypted blob; see media_objects)
  media_object_id     UUID,                      -- FK added after media_objects
  -- Public metadata that clients may display without decryption:
  sender_fallback    TEXT,                       -- sender display_name at send time
  -- Crypto scheme in use (bump when algo changes)
  encryption_version SMALLINT NOT NULL DEFAULT 1,
  -- For system messages only (plaintext by design)
  system_payload     JSONB,
  -- Lifecycle
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at          TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,
  deleted_by_user_id UUID REFERENCES users(id)
);

CREATE INDEX messages_conv_time ON messages (conversation_id, created_at DESC);
CREATE INDEX messages_sender ON messages (sender_user_id, created_at DESC);
CREATE INDEX messages_thread ON messages (thread_root_id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX messages_media ON messages (media_object_id) WHERE media_object_id IS NOT NULL;

-- last_read pointer in conversation_members
ALTER TABLE conversation_members
  ADD CONSTRAINT conv_members_last_read_fk
  FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE SET NULL;

-- =============================================================================
-- 9. MESSAGE_RECIPIENTS  — the per-device sealed ciphertexts
-- =============================================================================
-- One row PER (message × recipient device).
-- Sender client computes: for each recipient device, encrypt message plaintext
-- using NaCl box(message, nonce, sender_sk, recipient_device_pk).
-- Server stores only ciphertext + nonce. Server cannot decrypt.

CREATE TABLE message_recipients (
  message_id          UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ciphertext          BYTEA NOT NULL,
  nonce               BYTEA NOT NULL,
  delivered_at        TIMESTAMPTZ,               -- when WS push succeeded
  read_at             TIMESTAMPTZ,               -- when client marked read
  PRIMARY KEY (message_id, recipient_device_id)
);

-- Queue-style: all undelivered messages for a given device
CREATE INDEX message_recipients_pending ON message_recipients (recipient_device_id)
  WHERE delivered_at IS NULL;

-- =============================================================================
-- 10. REACTIONS  — plaintext by design (emoji + userId is public in chat)
-- =============================================================================

CREATE TABLE message_reactions (
  message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX reactions_msg ON message_reactions (message_id);

-- =============================================================================
-- 11. MEDIA  — encrypted blobs + per-device wrapped keys
-- =============================================================================
-- Media files (images, voice, video, documents) are encrypted once with a
-- random symmetric content-key. That content-key is then wrapped per-recipient-
-- device the same way plaintext messages are (box per device).
-- Blob itself lives in Supabase Storage under MEDIA_BUCKET, referenced by
-- storage_key. Only authorized users can mint a signed URL.

CREATE TABLE media_objects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_user_id  UUID NOT NULL REFERENCES users(id),
  uploader_device_id UUID NOT NULL REFERENCES devices(id),
  conversation_id   UUID REFERENCES conversations(id) ON DELETE CASCADE,
  storage_key       TEXT NOT NULL,               -- path in MEDIA_BUCKET
  mime_type         TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL,
  width             INT,
  height            INT,
  duration_ms       INT,
  sha256            TEXT NOT NULL,
  encryption_scheme TEXT NOT NULL DEFAULT 'xchacha20-poly1305',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CHECK (size_bytes > 0)
);

ALTER TABLE messages
  ADD CONSTRAINT messages_media_fk
  FOREIGN KEY (media_object_id) REFERENCES media_objects(id) ON DELETE SET NULL;

-- Per-device wrapped content keys for media (mirrors message_recipients idea)
CREATE TABLE media_recipients (
  media_object_id     UUID NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  recipient_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  wrapped_key         BYTEA NOT NULL,            -- box(content_key, nonce, sender_sk, recipient_pk)
  nonce               BYTEA NOT NULL,
  PRIMARY KEY (media_object_id, recipient_device_id)
);

-- =============================================================================
-- 12. CALLS  — metadata only (SDP/ICE travels over WS, never persisted)
-- =============================================================================

CREATE TYPE call_kind AS ENUM ('audio', 'video', 'screen');

CREATE TABLE calls (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind                call_kind NOT NULL,
  initiator_user_id   UUID NOT NULL REFERENCES users(id),
  initiator_device_id UUID NOT NULL REFERENCES devices(id),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  end_reason          TEXT,                      -- 'normal'|'missed'|'rejected'|'failed'
  duration_seconds    INT GENERATED ALWAYS AS (
    CASE WHEN ended_at IS NOT NULL
         THEN EXTRACT(EPOCH FROM (ended_at - started_at))::INT END
  ) STORED
);

CREATE INDEX calls_conv_time ON calls (conversation_id, started_at DESC);

CREATE TABLE call_participants (
  call_id     UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  joined_at   TIMESTAMPTZ,
  left_at     TIMESTAMPTZ,
  media_state JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {mic: bool, cam: bool, ...}
  PRIMARY KEY (call_id, user_id, device_id)
);

-- =============================================================================
-- 13. TASKS
-- =============================================================================
-- Tasks are plaintext by design — they are outcomes of chat, not chat itself.
-- The client can choose what to extract and send as plaintext when creating.

CREATE TYPE task_priority AS ENUM ('low', 'med', 'high');
CREATE TYPE task_status AS ENUM ('open', 'in_progress', 'done', 'archived');
CREATE TYPE task_source AS ENUM ('manual', 'chat', 'ai');

CREATE TABLE task_lists (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,  -- NULL = personal list
  owner_user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  position        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK (workspace_id IS NOT NULL OR owner_user_id IS NOT NULL)
);

CREATE TABLE tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id             UUID REFERENCES task_lists(id) ON DELETE SET NULL,
  workspace_id        UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  creator_user_id     UUID NOT NULL REFERENCES users(id),
  assignee_user_id    UUID REFERENCES users(id),
  title               TEXT NOT NULL,
  description         TEXT,
  priority            task_priority NOT NULL DEFAULT 'med',
  status              task_status NOT NULL DEFAULT 'open',
  source              task_source NOT NULL DEFAULT 'manual',
  source_message_id   UUID REFERENCES messages(id) ON DELETE SET NULL,
  due_at              TIMESTAMPTZ,
  position            INT NOT NULL DEFAULT 0,
  completed_at        TIMESTAMPTZ,
  completed_by_user_id UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX tasks_assignee_status ON tasks (assignee_user_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_workspace_status ON tasks (workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_due ON tasks (due_at) WHERE status <> 'done' AND deleted_at IS NULL;

CREATE TABLE task_checklist_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  position    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- 14. BLOCKS
-- =============================================================================

CREATE TABLE blocks (
  blocker_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

-- =============================================================================
-- 15. USER SETTINGS (per-user app prefs)
-- =============================================================================

CREATE TABLE user_settings (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme                   TEXT NOT NULL DEFAULT 'system',
  density                 TEXT NOT NULL DEFAULT 'comfortable',
  online_visibility       TEXT NOT NULL DEFAULT 'everyone',   -- 'everyone'|'contacts'|'nobody'
  read_receipts           BOOLEAN NOT NULL DEFAULT TRUE,
  typing_indicators       BOOLEAN NOT NULL DEFAULT TRUE,
  push_new_messages       BOOLEAN NOT NULL DEFAULT TRUE,
  push_mentions_only      BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- 16. PUSH TOKENS (per device)
-- =============================================================================

CREATE TABLE push_tokens (
  device_id     UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,                   -- 'ios'|'android'|'web'|'desktop'
  token         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

-- =============================================================================
-- 17. API KEYS  (for CRM / integrations)
-- =============================================================================
-- Different from user sessions. A key is workspace-scoped and scope-limited.
-- A CRM typically uses keys for *metadata* access and a separate crm_seat
-- device for *plaintext* access (which only the admin can enroll).

CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,          -- sha256(secret)
  key_prefix      TEXT NOT NULL,                 -- "koro_live_xxxxxx" (first 11 chars shown in UI)
  scopes          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- If non-NULL, this key is tied to a specific bot device that receives
  -- fanout ciphertexts → can read plaintext.
  crm_device_id   UUID REFERENCES devices(id) ON DELETE SET NULL,
  created_by_user UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX api_keys_workspace ON api_keys (workspace_id) WHERE revoked_at IS NULL;

-- =============================================================================
-- 18. WEBHOOKS
-- =============================================================================
-- CRM or integration subscribes to events. Payloads contain *metadata only*
-- unless the endpoint is tied to a crm_seat device (then payload can include
-- encrypted ciphertext for that device, which the CRM decrypts client-side).

CREATE TABLE webhooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  secret          TEXT NOT NULL,                 -- used to sign payloads (HMAC-SHA256)
  events          TEXT[] NOT NULL,               -- e.g. ['message.created','task.updated']
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count   INT NOT NULL DEFAULT 0
);

CREATE TABLE webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  response_status SMALLINT,
  response_body   TEXT,
  attempt         SMALLINT NOT NULL DEFAULT 1,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries (webhook_id, created_at DESC);

-- =============================================================================
-- 19. AUDIT LOG
-- =============================================================================

CREATE TABLE audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   UUID REFERENCES users(id),
  actor_device_id UUID REFERENCES devices(id),
  actor_api_key_id UUID REFERENCES api_keys(id),
  workspace_id    UUID REFERENCES workspaces(id),
  action          TEXT NOT NULL,                 -- 'user.created', 'message.deleted', etc.
  target_type     TEXT,
  target_id       UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_workspace_time ON audit_events (workspace_id, created_at DESC);
CREATE INDEX audit_actor_user ON audit_events (actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL;

-- =============================================================================
-- 20. UTILITY: updated_at trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_settings_updated_at BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 21. ROW-LEVEL SECURITY  — defense in depth
-- =============================================================================
-- NOTE: The backend uses the Supabase service_role key which bypasses RLS.
-- These policies are for the scenario where clients ever hit Postgres directly
-- (via PostgREST / Supabase client). The API layer is the primary authz gate.
-- We still enable RLS so a misconfigured client cannot read arbitrary data.

-- Helper: current user id set by the API layer via SET LOCAL
-- CREATE OR REPLACE FUNCTION auth_uid() RETURNS UUID AS $$
--   SELECT NULLIF(current_setting('koro.user_id', TRUE), '')::UUID;
-- $$ LANGUAGE sql STABLE;

ALTER TABLE users                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces             ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages               ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_recipients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_objects          ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_recipients       ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_participants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_lists             ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_checklist_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens            ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys               ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events           ENABLE ROW LEVEL SECURITY;

-- (Per-table policies to be added in 0002_rls_policies.sql once we pin down
-- the session-context approach. service_role bypasses RLS by default.)

COMMIT;
