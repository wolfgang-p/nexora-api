-- One-time cleanup of duplicate device rows.
--
-- Before the device-reuse fix, every login minted a BRAND-NEW devices row even
-- when the phone re-used the exact same identity keypair. Over months a single
-- physical phone accumulated many non-revoked device rows that all share one
-- identity_public_key. Consequences the user actually sees:
--   • ~10 push notifications for one message/call (message fanned out to every
--     stale device, each with the same push token),
--   • history-backfill churn re-sealing to dead targets.
--
-- The push layer now dedupes by token string, so the duplicate banners are gone
-- regardless. This migration additionally collapses the duplicates at the source:
-- for each (user_id, identity_public_key) it KEEPS the most-recently-enrolled
-- non-revoked device and revokes the older siblings. Future logins reuse the
-- kept row (see src/auth/otp.js verifyOtp), so no new duplicates accrue.
--
-- Scope: only phone/desktop-style personal devices. OAuth ("Login mit Koro")
-- devices are per-grant and are managed separately by the OAuth flow — never
-- touched here. Already-revoked rows are left as-is.
--
-- Safe to run multiple times (idempotent: once collapsed there is nothing left
-- to revoke).

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY user_id, identity_public_key
      ORDER BY enrolled_at DESC, id DESC
    ) AS rn
  FROM devices
  WHERE revoked_at IS NULL
    AND kind <> 'oauth'
)
UPDATE devices d
SET revoked_at = now(),
    revoked_reason = 'dedupe_duplicate_device'
FROM ranked r
WHERE d.id = r.id
  AND r.rn > 1;

-- Drop push tokens that belonged to the now-revoked duplicate device rows so we
-- never even consider them again (the surviving device keeps its own token).
DELETE FROM push_tokens p
USING devices d
WHERE p.device_id = d.id
  AND d.revoked_at IS NOT NULL
  AND d.revoked_reason = 'dedupe_duplicate_device';
