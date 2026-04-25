-- 0012_p6_threads_stories_files.sql
-- Fixes the `poll` enum value from 0011 (which referenced a type that
-- didn't yet have the value added) and adds schema for P6.2 threads,
-- P6.1 stories, and P6.2 shared files.

-- ── 1. Enum fixups ───────────────────────────────────────────────────
-- `CREATE TYPE … AS ENUM` from 0001 doesn't include 'poll'. Add it.
-- `ADD VALUE IF NOT EXISTS` cannot run inside a transaction in older
-- PG versions, so this must be executed outside one. The Supabase SQL
-- editor handles each statement individually.
ALTER TYPE message_kind ADD VALUE IF NOT EXISTS 'poll';

-- ── 2. Threads ───────────────────────────────────────────────────────
-- A thread is just a chain of messages that share a `thread_root_id`.
-- The root is the original message; every reply carries its id. A reply
-- to a reply collapses to the same root so the thread stays flat.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS thread_root_id UUID REFERENCES messages(id) ON DELETE SET NULL;

-- Indexed lookup: "give me all messages in thread X, oldest first"
CREATE INDEX IF NOT EXISTS messages_thread_root_idx
  ON messages (thread_root_id, created_at)
  WHERE thread_root_id IS NOT NULL;

-- Per-user, per-thread read pointer. Used for the unread counter badge
-- on the root message bubble.
CREATE TABLE IF NOT EXISTS thread_reads (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_root_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, thread_root_id)
);

-- ── 3. Stories ───────────────────────────────────────────────────────
-- 24h-ephemeral posts, addressed to the creator's workspace members
-- (if workspace_id is set) OR to a specific set of user_ids (personal
-- stories to contacts). E2E stays intact: the story body is sealed
-- per-recipient-device via `story_recipients`, same pattern as messages.
CREATE TABLE IF NOT EXISTS stories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('text', 'image', 'video')),
  -- Media uploads reuse the existing media_objects pipeline. For text
  -- stories this stays null.
  media_object_id UUID REFERENCES media_objects(id) ON DELETE SET NULL,
  -- Non-sensitive metadata to help the viewer render the right aspect
  -- ratio + caption-limit UX before decryption.
  width_hint      INTEGER,
  height_hint     INTEGER,
  duration_ms     INTEGER,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS stories_creator_idx ON stories (creator_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stories_active_idx  ON stories (expires_at)
  WHERE deleted_at IS NULL;

-- Per-recipient-device sealed payload (matches message_recipients pattern).
CREATE TABLE IF NOT EXISTS story_recipients (
  story_id            UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  recipient_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ciphertext          TEXT NOT NULL,
  nonce               TEXT NOT NULL,
  PRIMARY KEY (story_id, recipient_device_id)
);

-- View tracking — one row per viewer. Seen-receipts. Anonymized if the
-- creator's workspace policy demands it (future).
CREATE TABLE IF NOT EXISTS story_views (
  story_id   UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, user_id)
);

-- Reactions on stories (reuses the emoji model but is a separate table
-- so reactions on expired stories can persist as analytics metadata).
CREATE TABLE IF NOT EXISTS story_reactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id    UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (story_id, user_id, emoji)
);

-- ── 4. Shared Files / Drive ──────────────────────────────────────────
-- Workspace-wide file library. Files themselves live in media_objects
-- (already E2E-sealed per workspace-device). This table just gives
-- each workspace a curated "Drive" folder with title, tags, description
-- that aren't tied to a specific chat.
CREATE TABLE IF NOT EXISTS workspace_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploader_user_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  media_object_id UUID NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  -- Plaintext fields intentionally: filename + description are visible
  -- to every workspace member anyway once they open the file. We trade
  -- them for searchability. The content itself stays E2E.
  name            TEXT NOT NULL,
  description     TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  pinned_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workspace_files_ws_idx
  ON workspace_files (workspace_id, pinned_at DESC NULLS LAST, created_at DESC)
  WHERE deleted_at IS NULL;
-- Trigram search on name/description — needs pg_trgm; skip the index if
-- the extension isn't installed (Supabase ships it by default).
-- CREATE INDEX IF NOT EXISTS workspace_files_search_idx
--   ON workspace_files USING gin ((name || ' ' || coalesce(description,'')) gin_trgm_ops)
--   WHERE deleted_at IS NULL;
