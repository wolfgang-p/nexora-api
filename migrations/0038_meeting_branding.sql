-- 0038_meeting_branding.sql
-- Per-meeting white-label branding (optional).
--
-- When a meeting is created from a branded entry point (e.g. an oms-cluster
-- instance links to meet.nexoro.net with brand params), we FIX that instance's
-- branding onto the meeting so anyone who later opens the plain /m/<room> link
-- sees the same colors + logo — WITHOUT the params ever appearing in the URL.
--
-- All columns are nullable and default NULL: a meeting created on plain Koro
-- (meet.koro.chat, no brand params) simply has no branding → default look.

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS brand_primary TEXT,     -- hex, e.g. #1CABB8
  ADD COLUMN IF NOT EXISTS brand_accent  TEXT,     -- hex, e.g. #5EEAD4
  ADD COLUMN IF NOT EXISTS brand_logo    TEXT,     -- absolute https URL to a logo image
  ADD COLUMN IF NOT EXISTS brand_name    TEXT;     -- instance display name (wordmark)
