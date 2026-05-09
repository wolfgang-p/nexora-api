'use strict';

/**
 * Recovery codes — 32-char alphanumeric strings the user wrote down /
 * exported when first setting up their device. The plaintext lives ONLY
 * on the device that generated it; the server stores `sha256(code)`.
 *
 * Endpoints:
 *   POST /auth/recovery/register  (auth)  — uploads code_hash for the user
 *   DELETE /auth/recovery/register  (auth) — clears it
 *   POST /auth/recovery/verify  (no-auth) — phone + code → mint session
 *
 * Verify is the new-device escape hatch: phone OTP still works, but
 * if a user lost SIM access entirely, they can replay the recovery
 * code to sign in. Requires exact match (constant-time compare) — no
 * partial-match leakage.
 */

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { signAccess } = require('./jwt');
const { sha256, randomBase64Url, deviceFingerprint } = require('../util/crypto');
const { audit } = require('../util/audit');
const { recordLogin } = require('./loginHistory');
const { readJson, ok, badRequest, unauthorized, forbidden, serverError } = require('../util/response');
const config = require('../config');

function normalizeCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip the visual separators we use ("·" and spaces) and uppercase.
  // The hash is computed against the raw alphanumeric character stream.
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (cleaned.length < 16 || cleaned.length > 64) return null;
  return cleaned;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function registerCode(req, res) {
  const body = await readJson(req).catch(() => null);
  const code = normalizeCode(body?.code);
  if (!code) return badRequest(res, 'Valid code required');

  const codeHash = hashCode(code);
  const { error } = await supabase.from('users').update({
    recovery_code_hash: codeHash,
    recovery_code_set_at: new Date().toISOString(),
  }).eq('id', req.auth.userId);
  if (error) return serverError(res, 'Update failed', error);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, action: 'recovery.register', req });
  ok(res, { ok: true });
}

async function clearCode(req, res) {
  await supabase.from('users').update({
    recovery_code_hash: null, recovery_code_set_at: null,
  }).eq('id', req.auth.userId);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, action: 'recovery.clear', req });
  ok(res, { ok: true });
}

async function verifyAndLogin(req, res) {
  const body = await readJson(req).catch(() => null);
  const code = normalizeCode(body?.code);
  const phone = (typeof body?.phone_e164 === 'string') ? body.phone_e164.trim() : null;
  const deviceInput = body?.device || {};
  if (!code || !phone) return badRequest(res, 'phone_e164 + code required');
  if (!deviceInput.kind || !deviceInput.identity_public_key) {
    return badRequest(res, 'device.kind + identity_public_key required');
  }

  const { data: user } = await supabase.from('users')
    .select('id, recovery_code_hash, deleted_at').eq('phone_e164', phone).maybeSingle();
  if (!user || user.deleted_at) return unauthorized(res, 'No account');
  if (!user.recovery_code_hash) return forbidden(res, 'Recovery not enabled');

  const codeHash = hashCode(code);
  // Constant-time compare against timing-leak.
  const a = Buffer.from(codeHash, 'hex');
  const b = Buffer.from(user.recovery_code_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return unauthorized(res, 'Invalid code');
  }

  // Register the new device + mint session — same shape as verifyOtp.
  const pubKey = String(deviceInput.identity_public_key);
  const fingerprint = deviceFingerprint(Buffer.from(pubKey, 'base64'));
  const { data: device, error: devErr } = await supabase.from('devices').insert({
    user_id: user.id,
    kind: deviceInput.kind,
    label: deviceInput.label || null,
    identity_public_key: pubKey,
    fingerprint,
    user_agent: deviceInput.user_agent || req.headers['user-agent'] || null,
    ip_hint: req.socket?.remoteAddress || null,
  }).select('*').single();
  if (devErr) return serverError(res, 'Device register failed', devErr);

  const accessToken = signAccess({ userId: user.id, deviceId: device.id });
  const refreshToken = randomBase64Url(48);
  const refreshHash = sha256(refreshToken);
  const refreshExpires = new Date(Date.now() + config.jwt.refreshTtl * 1000).toISOString();
  await supabase.from('sessions').insert({
    user_id: user.id, device_id: device.id,
    refresh_token_hash: refreshHash, expires_at: refreshExpires,
  });

  // Burn the recovery code — it's a one-time bypass. The user has to
  // generate a new one once they're back in.
  await supabase.from('users').update({
    recovery_code_hash: null, recovery_code_set_at: null,
  }).eq('id', user.id);

  await recordLogin({ userId: user.id, deviceId: device.id, mode: 'recovery', req });
  audit({ userId: user.id, deviceId: device.id, action: 'recovery.verify', req });

  ok(res, {
    access_token: accessToken,
    refresh_token: refreshToken,
    user: { id: user.id },
    device: { id: device.id, fingerprint: device.fingerprint },
  });
}

module.exports = { registerCode, clearCode, verifyAndLogin };
