-- 0030_meeting_invites.sql
-- "Invite to meeting" — a chat message that renders as a meeting preview card
-- (title, time, "Meeting beitreten" button) in the recipient's conversation.
--
-- Stays end-to-end encrypted: the client seals the card payload
-- ({ meeting_id, title, scheduled_at, room_id, url }) per recipient device in
-- the message ciphertext, exactly like 'poll'. The server only learns *which*
-- meeting an invite points at (for validation + de-duplication), never the
-- sealed card body. The meeting itself (koro-meet) is already plaintext, so the
-- room_id is not a secret; we still keep the envelope minimal.

-- ── 1. New message kind ──────────────────────────────────────────────
-- `ADD VALUE IF NOT EXISTS` cannot run inside a transaction in older PG
-- versions — run this statement on its own (the Supabase SQL editor does).
ALTER TYPE message_kind ADD VALUE IF NOT EXISTS 'meeting_invite';

-- ── 2. Invite → meeting link (plaintext FK only) ─────────────────────
-- Mirrors the `polls` metadata pattern: one row per invite message, holding
-- just the foreign key to the meeting. No title/time stored here — those live
-- in the (already plaintext) `meetings` row and inside the sealed message body.
CREATE TABLE IF NOT EXISTS message_meetings (
  message_id  UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  meeting_id  UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_meetings_meeting_idx
  ON message_meetings (meeting_id);
