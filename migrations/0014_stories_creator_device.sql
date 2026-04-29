-- 0014_stories_creator_device.sql
-- Stories were missing the creator's device id, so the receiver couldn't
-- look up the public key for nacl.box.open() — every story decoded as
-- "Invalid encoding" / "Failed to decrypt" / null. We add the column,
-- backfill what we can, then make it NOT NULL going forward.

ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS creator_device_id UUID
    REFERENCES devices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS stories_creator_device_idx
  ON stories (creator_device_id);

-- Best-effort backfill: pick any non-revoked device of the creator that
-- existed before the story was created. Stories with no matching device
-- stay null — the client will skip decrypting them and just show the
-- story-kind icon.
UPDATE stories s
SET creator_device_id = (
  SELECT d.id FROM devices d
  WHERE d.user_id = s.creator_user_id
    AND (d.revoked_at IS NULL OR d.revoked_at > s.created_at)
  ORDER BY d.created_at ASC
  LIMIT 1
)
WHERE s.creator_device_id IS NULL;
