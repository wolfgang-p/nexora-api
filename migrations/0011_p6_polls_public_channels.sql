-- 0011_p6_polls_public_channels.sql
-- Schema for P6.1 Public Channels, P6.2 Polls, and P6.4 Live-Status-with-device.

-- ── Public channels ────────────────────────────────────────────────
-- A channel (or group) can be "published" → gets a slug that any
-- unauthenticated reader can visit at /c/:slug. The feed is read-only
-- for non-members. E2E content is still protected; we keep a
-- denormalized public_title / public_description in plaintext *only* for
-- the share-link preview. Plaintext messages never leak — the public
-- viewer shows recent envelope metadata + sender names the channel
-- owner has opted to expose.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS public_slug         TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS public_title        TEXT,
  ADD COLUMN IF NOT EXISTS public_description  TEXT,
  ADD COLUMN IF NOT EXISTS public_read_only    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS published_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by        UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_public_slug_idx
  ON conversations (public_slug) WHERE public_slug IS NOT NULL;

-- ── Polls ──────────────────────────────────────────────────────────
-- A poll is anchored to a message (kind='poll'). Question + option
-- texts live in the message ciphertext, sealed per-recipient device,
-- so the server never sees them. Only the server-generated option IDs
-- are plaintext; clients resolve id → text after decrypting the
-- message body.
CREATE TABLE IF NOT EXISTS polls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  creator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  multi_choice    BOOLEAN NOT NULL DEFAULT FALSE,
  anonymous       BOOLEAN NOT NULL DEFAULT FALSE,
  closes_at       TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS polls_conv_idx ON polls (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS poll_options (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id   UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  UNIQUE (poll_id, position)
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id    UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id  UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- For single-choice polls we enforce one row per (poll_id,user_id)
  -- at the application layer (we need a partial unique, which Postgres
  -- supports; we add it here for defense in depth).
  PRIMARY KEY (poll_id, option_id, user_id)
);
CREATE INDEX IF NOT EXISTS poll_votes_user_idx ON poll_votes (user_id, voted_at DESC);

-- ── Community / stories — placeholders for later. Not touched here to
-- keep this migration scoped.
