-- =============================================================================
-- Koro — BYTEA → TEXT(base64) migration
-- =============================================================================
-- Reason: supabase-js serializes Node Buffer values as `{type:"Buffer",data:[…]}`
-- when talking to PostgREST, which corrupts BYTEA roundtrips. Storing keys and
-- ciphertexts as base64 strings eliminates the format-mismatch class of bugs
-- entirely.
--
-- This migration wipes any existing key/ciphertext rows (they're junk anyway
-- because of the bug) and re-types the columns to TEXT. Users must log out
-- and re-verify their phone to enroll a fresh device.
-- =============================================================================

BEGIN;

-- Drop dependent crypto data. sessions are cascaded via devices; we also wipe
-- pairing_sessions, message_recipients, media_recipients which hold BYTEA blobs.
TRUNCATE TABLE message_recipients CASCADE;
TRUNCATE TABLE media_recipients   CASCADE;
TRUNCATE TABLE pairing_sessions   CASCADE;
TRUNCATE TABLE sessions           CASCADE;
TRUNCATE TABLE devices            CASCADE;
UPDATE users SET identity_public_key = NULL;

-- Re-type columns. All now hold base64-encoded strings, not raw bytes.
ALTER TABLE users              ALTER COLUMN identity_public_key      TYPE TEXT USING NULL;

ALTER TABLE devices            ALTER COLUMN identity_public_key      TYPE TEXT;
ALTER TABLE devices            ALTER COLUMN signing_public_key       TYPE TEXT;
ALTER TABLE devices            ALTER COLUMN signed_prekey_public     TYPE TEXT;
ALTER TABLE devices            ALTER COLUMN signed_prekey_signature  TYPE TEXT;

ALTER TABLE pairing_sessions   ALTER COLUMN ephemeral_public_key     TYPE TEXT;
ALTER TABLE pairing_sessions   ALTER COLUMN ciphertext               TYPE TEXT;
ALTER TABLE pairing_sessions   ALTER COLUMN nonce                    TYPE TEXT;

ALTER TABLE message_recipients ALTER COLUMN ciphertext               TYPE TEXT;
ALTER TABLE message_recipients ALTER COLUMN nonce                    TYPE TEXT;

ALTER TABLE media_recipients   ALTER COLUMN wrapped_key              TYPE TEXT;
ALTER TABLE media_recipients   ALTER COLUMN nonce                    TYPE TEXT;

COMMIT;
