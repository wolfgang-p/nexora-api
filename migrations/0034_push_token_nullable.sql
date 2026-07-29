-- 0034_push_token_nullable.sql
-- Makes push_tokens.token NULLABLE.
--
-- WHY: a device can legitimately register ONLY a VoIP (PushKit) token before
-- it ever obtains a regular Expo/APNs token — PushKit registration happens at
-- app launch and needs no notification permission, whereas the regular token
-- only arrives after the user grants notifications. The client then POSTs
-- { voip_token } alone. With `token NOT NULL` (from 0001_core), that upsert
-- failed with:
--   null value in column "token" of relation "push_tokens" violates not-null
-- so the voip_token was NEVER stored → killed-app CallKit never rang
-- (server saw 0 voip_tokens despite the client uploading successfully).
--
-- 0017 added voip_token but forgot to relax this constraint. Fix it now.
-- Idempotent: DROP NOT NULL is a no-op if already dropped.

ALTER TABLE push_tokens
  ALTER COLUMN token DROP NOT NULL;

-- Safety: a row must carry AT LEAST ONE token — otherwise it's meaningless.
-- (Named so a re-run doesn't duplicate it.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'push_tokens_has_a_token'
      AND conrelid = 'push_tokens'::regclass
  ) THEN
    ALTER TABLE push_tokens
      ADD CONSTRAINT push_tokens_has_a_token
      CHECK (token IS NOT NULL OR voip_token IS NOT NULL);
  END IF;
END $$;
