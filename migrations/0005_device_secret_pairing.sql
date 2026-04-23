-- Add device secret key sharing during pairing (Option A)
-- The mobile device encrypts its device secret key to the ephemeral public key
-- and sends it during /deliver. The web device can then decrypt and sync message history.
--
-- Also: store the NEW device's identity public key at session-creation time so
-- the claiming mobile can register the new device with its correct public key
-- (not the mobile's own). This also supports manual code entry (no QR).

ALTER TABLE pairing_sessions
ADD COLUMN device_secret_ciphertext TEXT,
ADD COLUMN device_secret_nonce TEXT,
ADD COLUMN new_device_identity_key TEXT;
