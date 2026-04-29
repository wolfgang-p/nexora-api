-- 0015_communities_bots_themes_calendar.sql
-- Schema for: P6.1 Communities, P6.2 Bots/Inbound-Webhooks,
-- P6.4 Custom Themes, P6.2 Calendar-Integration.

-- ── Communities (Workspace-of-Workspaces) ────────────────────────────
-- A community groups multiple workspaces under one umbrella with its
-- own membership and discovery surface.
CREATE TABLE IF NOT EXISTS communities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  avatar_url      TEXT,
  visibility      TEXT NOT NULL DEFAULT 'private',
  -- enum-ish: 'private' | 'invite_only' | 'public'
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK (visibility IN ('private', 'invite_only', 'public'))
);
CREATE INDEX IF NOT EXISTS communities_slug_idx
  ON communities (slug) WHERE slug IS NOT NULL AND deleted_at IS NULL;

-- A workspace can belong to at most one community at a time.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS community_id UUID REFERENCES communities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS workspaces_community_idx
  ON workspaces (community_id) WHERE community_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS community_members (
  community_id    UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member',
  -- enum-ish: 'owner' | 'admin' | 'member' | 'guest'
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  PRIMARY KEY (community_id, user_id),
  CHECK (role IN ('owner', 'admin', 'member', 'guest'))
);

-- ── Bots / Inbound webhooks ──────────────────────────────────────────
-- An inbound webhook is a unique URL token. Posting to it drops a
-- system message into the bound conversation. Optional HMAC verifies
-- payloads from GitHub / Linear / Sentry / etc.
CREATE TABLE IF NOT EXISTS inbound_webhooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  -- The URL slug — random, unguessable. Owner copies it into the
  -- third-party tool's webhook setting.
  token           TEXT NOT NULL UNIQUE,
  -- Optional HMAC secret. If set, every POST must carry the matching
  -- signature header (configurable per provider).
  hmac_secret     TEXT,
  provider        TEXT,
  -- enum-ish: 'github' | 'linear' | 'sentry' | 'zapier' | 'generic'
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_received_at TIMESTAMPTZ,
  receive_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbound_webhooks_token_idx
  ON inbound_webhooks (token) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS inbound_webhooks_conv_idx
  ON inbound_webhooks (conversation_id);

-- ── Custom Themes ────────────────────────────────────────────────────
-- Per-user color preferences + chat wallpaper. Theme JSON is opaque to
-- the server — clients render their own scheme; the server just
-- syncs the choice across devices.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS theme_mode      TEXT,
  -- 'light' | 'dark' | 'system' (default system)
  ADD COLUMN IF NOT EXISTS theme_accent    TEXT,
  -- hex color override, e.g. '#7C3AED'
  ADD COLUMN IF NOT EXISTS chat_wallpaper  TEXT,
  -- pre-defined wallpaper name OR a media_object_id reference
  ADD COLUMN IF NOT EXISTS animated_avatar BOOLEAN NOT NULL DEFAULT TRUE,
  -- Lottie-rendered avatar opt-in
  ADD COLUMN IF NOT EXISTS reduce_motion   BOOLEAN NOT NULL DEFAULT FALSE,
  -- A11y: respect "Reduce Motion" beyond OS default
  ADD COLUMN IF NOT EXISTS larger_text     BOOLEAN NOT NULL DEFAULT FALSE,
  -- A11y: bump base font sizes
  ADD COLUMN IF NOT EXISTS high_contrast   BOOLEAN NOT NULL DEFAULT FALSE,
  -- A11y: punch up borders + foreground contrast
  ADD COLUMN IF NOT EXISTS read_receipts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS typing_indicators_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── Calendar Integration ─────────────────────────────────────────────
-- Per-user link to a calendar provider. OAuth refresh tokens stay
-- server-side; client only sees the provider name + connected_at.
CREATE TABLE IF NOT EXISTS calendar_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  -- enum-ish: 'apple' | 'google'
  external_account_id TEXT,
  access_token    TEXT,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ,
  scopes          TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  UNIQUE (user_id, provider),
  CHECK (provider IN ('apple', 'google'))
);
CREATE INDEX IF NOT EXISTS calendar_links_user_idx
  ON calendar_links (user_id) WHERE revoked_at IS NULL;

-- Events that the user (or a chat) wants synced into a calendar.
CREATE TABLE IF NOT EXISTS calendar_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  -- The outward sync state — created/updated/deleted in the provider.
  external_event_id TEXT,
  provider        TEXT,
  title           TEXT NOT NULL,
  description     TEXT,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ,
  location        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS calendar_events_user_idx
  ON calendar_events (user_id, starts_at DESC);
