-- 0036_meeting_notes_and_recording.sql
-- koro-meet — shared collaborative notes + full meeting recording.
--
--   • meeting_notes: one shared notes document per meeting. Everyone can edit;
--     changes sync live over WS and are persisted here (last-write-wins). The
--     notes are shown in the post-meeting analysis, so they persist like the
--     analysis (NOT swept with the raw audio).
--   • meeting_analysis gets two columns for the host's optional FULL recording
--     (camera + screen + everyone's audio, mixed client-side by the host into
--     one video). The file lives as a media_objects row (conversation_id NULL →
--     publicly servable via /media/:id) and is referenced here.

CREATE TABLE IF NOT EXISTS meeting_notes (
  meeting_id   UUID PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  content      TEXT NOT NULL DEFAULT '',
  -- Last editor (for display / audit); nullable for guests.
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Full meeting recording reference on the analysis row. Safe to re-run.
ALTER TABLE meeting_analysis
  ADD COLUMN IF NOT EXISTS full_recording_media_id UUID REFERENCES media_objects(id) ON DELETE SET NULL;
ALTER TABLE meeting_analysis
  ADD COLUMN IF NOT EXISTS full_recording_status TEXT NOT NULL DEFAULT 'none'
    CHECK (full_recording_status IN ('none','recording','processing','ready','failed'));
