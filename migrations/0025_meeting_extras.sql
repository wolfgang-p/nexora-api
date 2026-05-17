-- 0025_meeting_extras.sql
-- koro-meet additions:
--   • banned_devices: host-side kick/ban list, keyed by the same
--     `device_id` the WS registry + meeting_participants use (already
--     prefixed with `meet:` for guests, bare uuid for koro users).
--     Join rejects any device whose id appears in this array.
--   • pdf: host can pin a single PDF for the duration of the meeting.
--     Stored as { media_id, url, name, uploaded_at, uploaded_by } so we
--     can re-serve it via the existing /media/:id pipeline.

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS banned_devices TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS pdf JSONB DEFAULT NULL;
