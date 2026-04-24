-- Flag messages that were forwarded from another chat. We don't keep a
-- back-reference to the source message id on purpose — the source may
-- live in a chat the recipient has no access to, which would leak
-- metadata. A simple boolean is enough for the "Weitergeleitet" badge.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ;
