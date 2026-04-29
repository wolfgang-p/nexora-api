-- 0018_msg_features.sql
-- Bundle of related per-conversation / per-message features:
--   • Disappearing messages: TTL on conversations + soft-delete sweep.
--   • Pinned messages:        messages.pinned_at, capped to 3 per conv.
--   • Edit history:           message_edits table holds prior plaintexts.
--   • Drafts sync:            per-conversation server-side draft.
-- All idempotent.

-- ── Disappearing messages ─────────────────────────────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS message_ttl_seconds INTEGER;

-- ── Pinned ────────────────────────────────────────────────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pinned_by UUID;

CREATE INDEX IF NOT EXISTS messages_pinned_idx
  ON messages(conversation_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

-- ── Edit history ──────────────────────────────────────────────────────────
-- The edited ciphertexts are still per-recipient (each message_recipient
-- row already has its own ciphertext/nonce). For the history we store one
-- canonical entry per edit on the SENDER's device — the sender's ciphertext
-- against their own key — same shape as message_recipients but flatter
-- because history doesn't need fan-out. Rendering: only the sender (and
-- by extension their other devices) can decrypt the history; that's fine,
-- a recipient seeing "edited" is enough.
CREATE TABLE IF NOT EXISTS message_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  edited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Same envelope shape as a regular message recipient row.
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  -- The device the sender was on when the edit happened — receiver uses
  -- this to look up the sealing public key.
  sender_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS message_edits_message_idx
  ON message_edits(message_id, edited_at DESC);

-- ── Drafts sync ───────────────────────────────────────────────────────────
-- One draft per (user, conversation). Stored as ciphertext sealed to the
-- user's OWN active devices so the server never sees plaintext drafts.
CREATE TABLE IF NOT EXISTS drafts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  -- The device that wrote this version (so other devices know if the
  -- pull from server is newer than their local copy).
  source_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id)
);

-- ── Stories: also cap reactions surface ──────────────────────────────────
-- (Reactions table already exists — we just need the index for "since I
-- last viewed the story" queries fired by the home avatar-ring badge.)
CREATE INDEX IF NOT EXISTS story_reactions_recent_idx
  ON story_reactions(story_id, created_at DESC);
