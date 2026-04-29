-- 0017_voip_push.sql
-- Adds the iOS PushKit (VoIP) token alongside the existing APNs/FCM
-- token on push_tokens. PushKit is sent on a separate channel and uses
-- the same APNs auth key as regular push, but a different topic
-- (`<bundle-id>.voip`). The mobile client now POSTs both tokens; only
-- iOS devices populate `voip_token`.

ALTER TABLE push_tokens
  ADD COLUMN IF NOT EXISTS voip_token TEXT;

CREATE INDEX IF NOT EXISTS push_tokens_voip_token_idx
  ON push_tokens(voip_token)
  WHERE voip_token IS NOT NULL;
