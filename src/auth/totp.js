'use strict';

/**
 * RFC-6238 TOTP — built on Node's `crypto`, no third-party dep.
 *
 * Endpoints:
 *   POST   /auth/totp/setup     — start enrolment, returns secret + otpauth_url
 *   POST   /auth/totp/enable    — confirm with first code, flips totp_enabled
 *   POST   /auth/totp/disable   — verify a current code, then clear secret
 *   POST   /auth/totp/verify    — challenge-response during login (no auth)
 *   GET    /auth/totp/backup-codes  — list remaining (one-shot reveal on enable)
 *   POST   /auth/totp/backup-codes/regenerate — replace, returns new printable list
 *
 * Login flow:
 *   1. User runs the normal phone-OTP flow.
 *   2. /auth/verify-otp checks `users.totp_enabled` — if true, returns
 *      `{ pending_totp: true, login_token }` (a short-lived 5-min JWT
 *      that's NOT a session token).
 *   3. Mobile shows /two-factor-verify, calls /auth/totp/verify with
 *      `{ login_token, code }`. On success it returns the real session.
 */

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, unauthorized, serverError } = require('../util/response');
const { signAccess, verifyLoginChallenge } = require('./jwt');
const { sha256, randomBase64Url } = require('../util/crypto');
const { audit } = require('../util/audit');
const { recordLogin } = require('./loginHistory');
const config = require('../config');

// ── Base32 (RFC 4648) ────────────────────────────────────────────────────
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const cleaned = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const ch of cleaned) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── HOTP / TOTP ─────────────────────────────────────────────────────────
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  // Big-endian 64-bit counter.
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

function currentCounter(now = Date.now()) {
  return Math.floor(now / 30_000);
}

/**
 * Verify a 6-digit code with ±1 step tolerance (handles clock skew).
 */
function verifyCode(secretBase32, code) {
  if (!secretBase32 || typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const c = currentCounter();
  for (const offset of [-1, 0, 1]) {
    if (hotp(secret, c + offset) === code) return true;
  }
  return false;
}

// ── Backup codes ─────────────────────────────────────────────────────────
function generateBackupCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(4);
    // 8 hex chars, lowercased and split with a dash for readability:
    // e.g. "9c4e-7a2f".
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
  });
}

function hashBackupCode(code) {
  // Strip the dash so a user typing without it still matches.
  const normalized = code.toLowerCase().replace(/-/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ── Endpoints ────────────────────────────────────────────────────────────

async function setup(req, res) {
  // Generate a fresh secret. Don't enable yet — user must confirm via
  // /enable with the first code from their authenticator app.
  const raw = crypto.randomBytes(20); // 160-bit per RFC 4226
  const secret = base32Encode(raw);

  const { data: user } = await supabase.from('users')
    .select('username, phone_e164').eq('id', req.auth.userId).maybeSingle();

  // Stash the candidate secret. `totp_enabled` stays false until /enable.
  const { error } = await supabase.from('users')
    .update({ totp_secret: secret, totp_enabled: false, totp_enabled_at: null })
    .eq('id', req.auth.userId);
  if (error) return serverError(res, 'TOTP setup failed', error);

  const account = encodeURIComponent(user?.username || user?.phone_e164 || 'koro');
  const otpauth = `otpauth://totp/Koro:${account}?secret=${secret}&issuer=Koro&algorithm=SHA1&digits=6&period=30`;

  ok(res, { secret, otpauth_url: otpauth });
}

async function enable(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.code) return badRequest(res, 'code required');

  const { data: user } = await supabase.from('users')
    .select('totp_secret, totp_enabled').eq('id', req.auth.userId).maybeSingle();
  if (!user?.totp_secret) return badRequest(res, 'Run /auth/totp/setup first');
  if (user.totp_enabled) return badRequest(res, 'Already enabled');
  if (!verifyCode(user.totp_secret, body.code)) return unauthorized(res, 'Invalid code');

  await supabase.from('users').update({
    totp_enabled: true,
    totp_enabled_at: new Date().toISOString(),
  }).eq('id', req.auth.userId);

  // Generate + persist backup codes — return the plaintext list in
  // the response (one-shot, never again).
  const codes = generateBackupCodes(10);
  const rows = codes.map((c) => ({
    user_id: req.auth.userId,
    code_hash: hashBackupCode(c),
  }));
  await supabase.from('backup_codes').insert(rows);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, action: 'totp.enable', req });
  ok(res, { ok: true, backup_codes: codes });
}

async function disable(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.code) return badRequest(res, 'code required');

  const { data: user } = await supabase.from('users')
    .select('totp_secret, totp_enabled').eq('id', req.auth.userId).maybeSingle();
  if (!user?.totp_enabled) return badRequest(res, 'Not enabled');

  // Accept either a current TOTP code or any unconsumed backup code.
  const valid = verifyCode(user.totp_secret, body.code) || (await consumeBackup(req.auth.userId, body.code));
  if (!valid) return unauthorized(res, 'Invalid code');

  await supabase.from('users').update({
    totp_secret: null, totp_enabled: false, totp_enabled_at: null,
  }).eq('id', req.auth.userId);
  await supabase.from('backup_codes').delete().eq('user_id', req.auth.userId);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, action: 'totp.disable', req });
  ok(res, { ok: true });
}

/**
 * Login challenge — called WITHOUT an active session, with the
 * short-lived `login_token` issued by /auth/verify-otp.
 */
async function verifyChallenge(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.login_token || !body?.code || !body?.device_id) {
    return badRequest(res, 'login_token + code + device_id required');
  }
  const claims = verifyLoginChallenge(body.login_token);
  if (!claims) return unauthorized(res, 'Login token expired');

  const { data: user } = await supabase.from('users')
    .select('id, totp_secret, totp_enabled').eq('id', claims.uid).maybeSingle();
  if (!user?.totp_enabled || !user.totp_secret) return badRequest(res, 'TOTP not enabled');

  const ok2 = verifyCode(user.totp_secret, body.code) || (await consumeBackup(user.id, body.code));
  if (!ok2) return unauthorized(res, 'Invalid code');

  // Mint the real session pair, log the login. Mirror otp.js's pattern
  // (signAccess + random refresh persisted as sha256 in `sessions`).
  const accessToken = signAccess({ userId: user.id, deviceId: body.device_id });
  const refreshToken = randomBase64Url(48);
  const refreshHash = sha256(refreshToken);
  const refreshExpires = new Date(Date.now() + config.jwt.refreshTtl * 1000).toISOString();
  await supabase.from('sessions').insert({
    user_id: user.id, device_id: body.device_id,
    refresh_token_hash: refreshHash, expires_at: refreshExpires,
  });

  await recordLogin({ userId: user.id, deviceId: body.device_id, mode: 'totp_verify', req });
  audit({ userId: user.id, deviceId: body.device_id, action: 'totp.verify', req });

  ok(res, { access_token: accessToken, refresh_token: refreshToken });
}

async function listBackupCodes(req, res) {
  const { data } = await supabase.from('backup_codes')
    .select('id, consumed_at, created_at')
    .eq('user_id', req.auth.userId)
    .order('created_at', { ascending: true });
  const remaining = (data || []).filter((r) => !r.consumed_at).length;
  ok(res, { total: (data || []).length, remaining });
}

async function regenerateBackupCodes(req, res) {
  await supabase.from('backup_codes').delete().eq('user_id', req.auth.userId);
  const codes = generateBackupCodes(10);
  const rows = codes.map((c) => ({ user_id: req.auth.userId, code_hash: hashBackupCode(c) }));
  await supabase.from('backup_codes').insert(rows);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, action: 'totp.regen_backup', req });
  ok(res, { backup_codes: codes });
}

async function consumeBackup(userId, code) {
  if (!code || typeof code !== 'string') return false;
  const hash = hashBackupCode(code);
  const { data } = await supabase.from('backup_codes')
    .select('id').eq('user_id', userId).eq('code_hash', hash).is('consumed_at', null).maybeSingle();
  if (!data) return false;
  await supabase.from('backup_codes').update({ consumed_at: new Date().toISOString() }).eq('id', data.id);
  return true;
}

module.exports = {
  setup, enable, disable,
  verifyChallenge, listBackupCodes, regenerateBackupCodes,
  // Exposed for /auth/verify-otp to detect "user has 2FA on".
  isTotpEnabled: async (userId) => {
    const { data } = await supabase.from('users')
      .select('totp_enabled').eq('id', userId).maybeSingle();
    return !!data?.totp_enabled;
  },
  // Exported for tests + local verification.
  _internal: { hotp, verifyCode, base32Encode, base32Decode },
};
