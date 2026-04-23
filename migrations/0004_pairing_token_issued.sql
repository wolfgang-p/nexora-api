-- Add token_issued_at column to pairing_sessions table
-- Tracks when token was issued to prevent re-issuance

BEGIN;

ALTER TABLE pairing_sessions
  ADD COLUMN token_issued_at TIMESTAMPTZ;

COMMIT;
