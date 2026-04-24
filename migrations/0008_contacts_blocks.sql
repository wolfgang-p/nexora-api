-- Contacts discovery + user blocking.
--
-- For privacy, contacts discovery works on SHA-256(phone_e164) hashes —
-- client sends a list of hashes and we return only the users whose own
-- phone hashes match. This lets us join contacts without ever sending
-- cleartext phone numbers from the user's address book.

-- Pre-computed hash so we can index it and do a single join.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_hash TEXT;

CREATE INDEX IF NOT EXISTS users_phone_hash_idx ON users (phone_hash)
  WHERE phone_hash IS NOT NULL;

-- User can block another user. All messages / calls / reactions /
-- reads from a blocked user are silently dropped server-side.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason          TEXT,
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx
  ON user_blocks (blocked_user_id);

-- Optional profile polish (not user-blocking, but P1.4 bundle):
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS status_text TEXT;
