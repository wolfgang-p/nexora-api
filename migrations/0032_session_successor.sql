-- Idempotent refresh rotation.
--
-- Problem: a refresh response can be lost in transit (flaky mobile network, the
-- app backgrounded mid-request). The server rotated the token and minted a
-- successor, but the client never received it and still holds the old, now
-- "rotated" token. On the NEXT refresh — which may be seconds or many DAYS later,
-- whenever the app is reopened — that old token looks like a replay. The previous
-- logic revoked ALL of the user's sessions after a 60-second grace window, which
-- is exactly the "I get logged out after a while and then can't decrypt my
-- messages" symptom.
--
-- Fix: remember which successor each rotated row minted. When the SAME
-- predecessor token is presented again, we can safely hand back the already
-- minted successor (idempotent replay of a lost response) instead of treating it
-- as theft — no matter how much time has passed. Genuine theft (a fork in the
-- rotation chain) is still detectable because the successor itself will have been
-- rotated onward.
--
-- Safe to run multiple times.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS successor_token_hash TEXT;

-- Fast lookup of the current successor when replaying a lost rotation.
CREATE INDEX IF NOT EXISTS idx_sessions_successor_token_hash
  ON sessions (successor_token_hash)
  WHERE successor_token_hash IS NOT NULL;
