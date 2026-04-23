-- Add device secret key sharing during pairing (Option A)
-- The mobile device encrypts its device secret key to the ephemeral public key
-- and sends it during /deliver. The web device can then decrypt and sync message history.

ALTER TABLE pairing_sessions
ADD COLUMN device_secret_ciphertext TEXT,
ADD COLUMN device_secret_nonce TEXT;
