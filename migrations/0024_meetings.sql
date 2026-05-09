-- 0024_meetings.sql
-- koro-meet — multi-participant video meetings (Google Meet style).
--
-- Design notes:
--   • Meetings are NOT end-to-end encrypted. Direct chats and koro
--     calls stay E2E; meetings are explicitly opt-in plaintext so we
--     can offer recording + chat history + 50-participant mesh.
--   • Both authed Koro users AND anonymous guests can join. Guests
--     identify by a `guest_name` they pick at the door — no account
--     required. The combination (meeting_id, device_id) uniquely
--     identifies a participation row.
--   • `room_id` is the URL slug (meet.koro.chat/<room_id>). Short,
--     base32-friendly (8-12 chars).
--
-- Three tables, all FK-cascading on meetings.id.

CREATE TABLE IF NOT EXISTS meetings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Public room slug — used in URLs. Distinct from the UUID id so the
  -- URL stays short + opaque.
  room_id         TEXT UNIQUE NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  -- Host: a Koro user OR null if a guest created the meeting.
  host_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  -- For guest-hosted meetings, freeze the display name at create-time
  -- so the dashboard still shows "Hosted by Anna" after the guest tab
  -- closes.
  host_name       TEXT,
  -- Optional anchoring to a workspace (private meeting room within a
  -- team) — null = personal / public meeting.
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  -- Hard cap on simultaneous participants. Mesh degrades past ~6;
  -- anything bigger needs an SFU. We persist the limit so the join
  -- handler can reject excess connections.
  max_participants INTEGER NOT NULL DEFAULT 50,
  allow_guests    BOOLEAN NOT NULL DEFAULT TRUE,
  -- Lock-down switch the host can flip mid-meeting; new joiners get
  -- a "meeting locked" response.
  locked          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meetings_room_idx ON meetings (room_id);
CREATE INDEX IF NOT EXISTS meetings_host_idx ON meetings (host_user_id) WHERE host_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meetings_scheduled_idx ON meetings (scheduled_at) WHERE scheduled_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS meeting_participants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- Authed Koro user OR null if guest. Exactly one of user_id /
  -- guest_name is set.
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  guest_name      TEXT,
  -- For Koro users this is their device id (so the WS knows where to
  -- relay signaling). For guests it's a per-tab UUID minted client-side
  -- and persisted in localStorage — same role: signaling target.
  device_id       TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  avatar_url      TEXT,
  is_host         BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  -- Tiny preferences carried across reconnects in the same browser tab.
  mic_on          BOOLEAN NOT NULL DEFAULT TRUE,
  camera_on       BOOLEAN NOT NULL DEFAULT TRUE,
  raised_hand_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_participants_active_unique
  ON meeting_participants (meeting_id, device_id)
  WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS meeting_participants_meeting_idx ON meeting_participants (meeting_id);

CREATE TABLE IF NOT EXISTS meeting_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- The participant row at the time of sending. Lets us render even
  -- after the user has left (display_name is frozen).
  participant_id UUID REFERENCES meeting_participants(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_messages_meeting_idx ON meeting_messages (meeting_id, created_at);
