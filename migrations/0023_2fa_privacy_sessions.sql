-- 0023_2fa_privacy_sessions.sql
--
-- Three orthogonal additions:
--   1. TOTP-based 2FA (RFC-6238) on top of phone+OTP login.
--   2. "Contact-only messaging" privacy gate.
--   3. Login-history rows + a list of trusted device fingerprints so we
--      can warn other devices on suspicious logins.
--
-- TOTP secrets are stored as the shared base32 seed. They cannot
-- decrypt anything — they only authenticate the second factor — so
-- they live at-rest in the same row as the user (Supabase RLS keeps
-- them out of the public API). Backup codes are 8 hex chars each,
-- stored as one-shot rows (consumed_at marks them used).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ,
  -- Recovery code: 32-char alphanumeric printed on the device once,
  -- stored as sha256(code) on the server. Used by /auth/recovery/verify
  -- to bypass phone-OTP when the user lost SIM/number access.
  ADD COLUMN IF NOT EXISTS recovery_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS recovery_code_set_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS backup_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The HEX hash (sha256) of the printable code. We never store the
  -- printable code itself — once shown, it's gone.
  code_hash   TEXT NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backup_codes_user ON backup_codes (user_id) WHERE consumed_at IS NULL;

-- Privacy: when on, only users in the address-book hash set OR with an
-- existing direct conversation can start a NEW direct chat with me.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS contact_only_messaging BOOLEAN NOT NULL DEFAULT FALSE,
  -- Per-user opt-in for Android FLAG_SECURE. iOS doesn't expose
  -- screenshot blocking to apps so this only affects Android.
  ADD COLUMN IF NOT EXISTS screenshot_blocked BOOLEAN NOT NULL DEFAULT FALSE;

-- Login history — every successful auth (OTP, refresh, pair, TOTP)
-- inserts one row. The "current" device polls /me/login-history and
-- shows the list in the security screen.
CREATE TABLE IF NOT EXISTS login_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    UUID REFERENCES devices(id) ON DELETE SET NULL,
  -- Mode: 'otp' | 'refresh' | 'pair' | 'totp_setup' | 'totp_verify'.
  mode         TEXT NOT NULL,
  ip           TEXT,
  -- ISO country code derived from IP at the edge. Cleared when null.
  country      TEXT,
  user_agent   TEXT,
  -- "Suspicious" = country differs from the user's last 30-day norm.
  -- Server marks the row at insert time so the client can highlight it
  -- without re-deriving.
  suspicious   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_history_user_time ON login_history (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS login_history_suspicious ON login_history (user_id) WHERE suspicious;
