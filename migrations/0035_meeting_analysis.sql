-- 0035_meeting_analysis.sql
-- koro-meet — post-meeting recording, transcription & AI analysis.
--
-- Design notes:
--   • Meetings are P2P mesh; the server never sees media live. So each
--     participant records their OWN mic in the browser and streams it
--     to the server in chunks (appended to one file per speaker). This
--     survives a participant leaving early / a dropped connection: only
--     the un-streamed tail is lost.
--   • After the host ends the meeting, a dedicated worker transcribes
--     each speaker's audio (Whisper, auto language) and produces a
--     German summary. Because streams are already per-speaker, "who
--     spoke when" needs no diarization — each recording IS one speaker.
--   • The analysis is shareable via an unlisted token (anyone with the
--     link can view — read-only, no auth). Same trust model as the
--     existing public-channel / null-conversation media serving.
--
-- All tables FK-cascade on meetings.id.

-- One row per speaker per meeting. The audio file lives on disk
-- (uploads/meetings/<meeting_id>/<device_id>.webm); storage_key points
-- to it. bytes/started_at/ended_at bound the recording.
CREATE TABLE IF NOT EXISTS meeting_recordings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id                UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- Signaling id of the speaker (Koro device id, or a guest's per-tab
  -- UUID). Matches meeting_participants.device_id.
  participant_device_id     TEXT NOT NULL,
  participant_display_name  TEXT NOT NULL,
  -- Koro user if authed, else null (guest).
  participant_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Relative path under the uploads root (e.g. meetings/<id>/<dev>.webm).
  storage_key               TEXT NOT NULL,
  mime_type                 TEXT NOT NULL DEFAULT 'audio/webm',
  bytes                     BIGINT NOT NULL DEFAULT 0,
  -- When the first / last chunk for this speaker arrived. Used to place
  -- the speaker on the meeting timeline.
  started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at                  TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One recording file per (meeting, speaker) — chunks append to it.
  UNIQUE (meeting_id, participant_device_id)
);

CREATE INDEX IF NOT EXISTS meeting_recordings_meeting_idx
  ON meeting_recordings (meeting_id);

-- Transcribed utterances. One recording yields one or more rows (a long
-- recording is split into Whisper-sized segments). Offsets are relative
-- to the recording start (ms) so the UI can build a chronological
-- speaker timeline across everyone.
CREATE TABLE IF NOT EXISTS meeting_transcripts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id            UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  recording_id          UUID REFERENCES meeting_recordings(id) ON DELETE CASCADE,
  speaker_display_name  TEXT NOT NULL,
  speaker_device_id     TEXT NOT NULL,
  text                  TEXT NOT NULL,
  started_offset_ms     BIGINT NOT NULL DEFAULT 0,
  ended_offset_ms       BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_transcripts_meeting_idx
  ON meeting_transcripts (meeting_id, started_offset_ms);

-- One analysis row per meeting. Drives the worker (status) and the
-- analysis / share pages. share_token is an unlisted, unguessable slug.
CREATE TABLE IF NOT EXISTS meeting_analysis (
  meeting_id    UUID PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed')),
  summary_md    TEXT,
  -- Unlisted share slug — anyone with the link can view the analysis.
  share_token   TEXT UNIQUE NOT NULL,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_analysis_status_idx
  ON meeting_analysis (status) WHERE status IN ('pending','processing');
