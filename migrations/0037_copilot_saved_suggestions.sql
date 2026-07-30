-- 0037_copilot_saved_suggestions.sql
-- koro-meet — private "Koro Copilot" suggestions a user chose to keep.
--
-- The live copilot is PRIVATE to the user who runs it; its suggestions are
-- ephemeral (RAM only). When the user copies/keeps a suggestion, we persist it
-- here so it can appear in THAT user's post-meeting analysis ("Das hat der
-- Copilot vorgeschlagen"). It is scoped to the owner device — it must NEVER show
-- up in the shared analysis (share_token) or for other participants.

CREATE TABLE IF NOT EXISTS meeting_copilot_suggestions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- Owner: the device that ran the copilot and kept this suggestion. Private to
  -- this device (and its user, if a Koro user).
  owner_device_id  TEXT NOT NULL,
  owner_user_id    UUID,
  kind         TEXT NOT NULL DEFAULT 'suggestion'
                 CHECK (kind IN ('objection','suggestion','nudge','answer')),
  title        TEXT,
  text         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_copilot_sugg_owner
  ON meeting_copilot_suggestions (meeting_id, owner_device_id, created_at);
