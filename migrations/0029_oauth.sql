-- 0029_oauth.sql
-- "Login with Koro" — third-party OAuth 2.0-style authorization.
--
-- A developer registers an OAuth *client* (an app) in the developer portal.
-- On their own website they offer a "Log in with Koro" button. When a user
-- clicks it, Koro shows a QR code; the user scans it with the Koro mobile app,
-- sees an in-app CONSENT screen listing exactly which permissions (scopes) the
-- app is asking for, and approves. Koro then hands the developer a scoped
-- access token that can act on that user's behalf — limited to the granted
-- scopes only.
--
-- The flow deliberately mirrors the existing pairing-QR state machine
-- (pending → approved → consumed), but instead of enrolling a new first-party
-- device it provisions a per-grant `api_bot` device that belongs to the USER
-- and carries the third-party app's identity public key. That keeps E2E
-- intact: peers seal message copies to this device's key, and the developer
-- (holding the matching secret) can open them — exactly like a bot, but owned
-- by the consenting user and revocable by them at any time.
--
-- Tables:
--   oauth_clients — the registered developer app (client_id + hashed secret,
--                   redirect URIs, the maximum scopes it may ever request).
--   oauth_grants  — one consent QR session (short-lived), its requested scopes,
--                   PKCE challenge, and — once approved — the user, the
--                   per-grant device, the granted scopes and a one-shot
--                   authorization code.
--   oauth_tokens  — issued access/refresh token records, for listing &
--                   revocation ("apps you've connected").
--
-- All idempotent.

-- ── allow a dedicated device kind for OAuth grants ─────────────────────────
-- `oauth` devices are per-grant identities owned by the consenting user. They
-- behave like api_bot devices for sealing, but are clearly attributable to a
-- "Login with Koro" connection in the device list.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'device_kind' AND e.enumlabel = 'oauth'
  ) THEN
    ALTER TYPE device_kind ADD VALUE 'oauth';
  END IF;
END$$;

-- ── oauth_clients: registered developer apps ──────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_clients (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id          TEXT NOT NULL UNIQUE,            -- public "koro_app_…" id
  client_secret_hash TEXT,                            -- sha256(secret); NULL for public/PKCE-only clients
  name               TEXT NOT NULL,                   -- shown on the consent screen
  logo_url           TEXT,                            -- shown on the consent screen
  homepage_url       TEXT,
  redirect_uris      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  scopes             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],  -- max scopes this app may request
  is_public          BOOLEAN NOT NULL DEFAULT false,  -- public clients use PKCE without a secret
  created_by_user    UUID NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS oauth_clients_workspace_idx
  ON oauth_clients (workspace_id, created_at DESC)
  WHERE revoked_at IS NULL;

-- ── oauth_grants: one consent QR session ───────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_grants (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  pairing_code           TEXT NOT NULL,                  -- short code shown under the QR
  requested_scopes       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  redirect_uri           TEXT,                           -- must match one of the client's
  state                  TEXT,                           -- opaque, echoed back to the dev
  -- PKCE (RFC 7636). Public clients MUST send a challenge; we only ever store
  -- the challenge (S256 hash), never the verifier.
  code_challenge         TEXT,
  code_challenge_method  TEXT,                           -- 'S256' | 'plain'
  status                 TEXT NOT NULL DEFAULT 'pending',-- pending|approved|consumed|denied|expired
  -- Filled on approval (by the consenting user in the mobile app):
  user_id                UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id              UUID REFERENCES devices(id) ON DELETE SET NULL,
  granted_scopes         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- The per-grant device's wrapped secret (sealed by the mobile app to the
  -- app's ephemeral key, exactly like pairing) so the developer can derive the
  -- E2E secret to open sealed message copies. Opaque base64 to the server.
  device_secret_ciphertext TEXT,
  device_secret_nonce      TEXT,
  device_secret_sender_key TEXT,                          -- throwaway sender pub used to seal (b64)
  ephemeral_public_key     TEXT,                          -- the app's ephemeral X25519 pub (b64)
  -- One-shot authorization code (hashed). Exchanged at /oauth/token.
  authorization_code_hash  TEXT,
  code_redeemed_at         TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL,            -- created_at + ~5 min
  approved_at            TIMESTAMPTZ,
  denied_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS oauth_grants_client_idx ON oauth_grants (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_grants_user_idx   ON oauth_grants (user_id) WHERE user_id IS NOT NULL;

-- ── oauth_tokens: issued tokens, for listing & revocation ─────────────────
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id             UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id            TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id            UUID REFERENCES devices(id) ON DELETE SET NULL,
  scopes               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  refresh_token_hash   TEXT NOT NULL UNIQUE,             -- sha256(opaque refresh token)
  refresh_rotated_at   TIMESTAMPTZ,                      -- set when rotated out (reuse detection)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at         TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS oauth_tokens_user_idx
  ON oauth_tokens (user_id, created_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_tokens_client_user_idx
  ON oauth_tokens (client_id, user_id)
  WHERE revoked_at IS NULL;

-- ── RLS (defense-in-depth; service-role bypasses, handlers enforce) ───────
ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_grants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens  ENABLE ROW LEVEL SECURITY;

-- Clients: managed by workspace admins.
DROP POLICY IF EXISTS oauth_clients_admin ON oauth_clients;
CREATE POLICY oauth_clients_admin ON oauth_clients
  FOR ALL USING (koro.is_ws_admin(workspace_id))
          WITH CHECK (koro.is_ws_admin(workspace_id));

-- Grants: a user can see grants they approved (their connected apps); the
-- consent/poll/approve handlers run service-role and enforce the rest.
DROP POLICY IF EXISTS oauth_grants_owner_select ON oauth_grants;
CREATE POLICY oauth_grants_owner_select ON oauth_grants
  FOR SELECT USING (user_id = koro.auth_uid());

-- Tokens: a user can see + revoke their own connected-app tokens.
DROP POLICY IF EXISTS oauth_tokens_owner ON oauth_tokens;
CREATE POLICY oauth_tokens_owner ON oauth_tokens
  FOR ALL USING (user_id = koro.auth_uid())
          WITH CHECK (user_id = koro.auth_uid());
