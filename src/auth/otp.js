'use strict';

const { supabase } = require('../db/supabase');
const { sha256, otpCode, randomBase64Url } = require('../util/crypto');
const { signAccess } = require('./jwt');
const { audit } = require('../util/audit');
const { readJson, ok, created, badRequest, unauthorized, serverError } = require('../util/response');
const { check, send429, clientIp } = require('../middleware/rateLimit');
const { sendOtp } = require('../sms');
const config = require('../config');

const OTP_LENGTH = 6;
const OTP_TTL_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 5;
const OTP_PEPPER = config.jwt.secret; // derive pepper from jwt secret for convenience

function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+')) return null;
  if (cleaned.length < 8 || cleaned.length > 16) return null;
  return cleaned;
}

/**
 * POST /auth/request-otp   { phone_e164 }
 */
async function requestOtp(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const phone = normalizePhone(body.phone_e164 || body.phone_number);
  if (!phone) return badRequest(res, 'Invalid phone number (E.164 required)');

  const ip = clientIp(req);
  const rlimit = check([
    // Short-burst: max 1 OTP per minute per phone — stops rapid click spam.
    { key: `otp:phone:min:${phone}`,  max: 1,  windowMs: 60 * 1000 },
    // Hourly ceiling per phone — stops long-term abuse of a single number.
    { key: `otp:phone:${phone}`,      max: 5,  windowMs: 60 * 60 * 1000 },
    // Per-IP ceiling (per minute + per hour) — stops a single source farming.
    { key: `otp:ip:min:${ip}`,        max: 10, windowMs: 60 * 1000 },
    { key: `otp:ip:${ip}`,            max: 30, windowMs: 60 * 60 * 1000 },
  ]);
  if (!rlimit.ok) return send429(res, rlimit);

  // Additional DB-level guard: max 3 active OTPs in the last 15 minutes.
  const { count } = await supabase
    .from('otps')
    .select('id', { count: 'exact', head: true })
    .eq('phone_e164', phone)
    .gt('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString());

  if ((count ?? 0) >= 3) {
    return badRequest(res, 'Too many OTP requests. Try again later.');
  }

  const code = otpCode(OTP_LENGTH);
  const codeHash = sha256(code, OTP_PEPPER);
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();

  const { error } = await supabase.from('otps').insert({
    phone_e164: phone,
    code_hash: codeHash,
    expires_at: expiresAt,
    ip_address: req.socket?.remoteAddress || null,
  });
  if (error) return serverError(res, 'Could not generate OTP', error);

  // Send the SMS. In production a failure must surface to the caller —
  // otherwise the user waits forever for a code that never arrives.
  try {
    await sendOtp(phone, code);
  } catch (err) {
    const msg = err?.message || String(err);
    // The message never contains the OTP (it's never logged). It may
    // reference the upstream carrier status code only.
    console.error('[sms:send failed]', msg);
    if (config.isProd) {
      // Roll back the DB row so the user can retry without hitting the
      // "3 active OTPs" guard on a failed delivery.
      try {
        await supabase.from('otps').delete()
          .eq('phone_e164', phone).eq('code_hash', codeHash);
      } catch {}
      return serverError(res, 'SMS delivery failed. Please try again.');
    }
  }

  ok(res, { ok: true, expires_in: OTP_TTL_SECONDS });
}

/**
 * POST /auth/verify-otp   { phone_e164, code, device: { kind, label, identity_public_key (b64), user_agent? } }
 * Returns: { access_token, refresh_token, user, device }
 */
async function verifyOtp(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const phone = normalizePhone(body.phone_e164 || body.phone_number);
  const code = String(body.code || '').trim();
  const deviceInput = body.device || {};
  if (!phone) return badRequest(res, 'Invalid phone number');
  if (!/^\d{6}$/.test(code)) return badRequest(res, 'Invalid code');
  if (!deviceInput.kind || !deviceInput.identity_public_key) {
    return badRequest(res, 'Device info (kind, identity_public_key) required');
  }

  // Pull latest active OTP for this phone
  const { data: otp } = await supabase
    .from('otps')
    .select('id, code_hash, expires_at, consumed_at, attempts')
    .eq('phone_e164', phone)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!otp) return unauthorized(res, 'OTP expired or not found');
  if (otp.attempts >= MAX_ATTEMPTS) return unauthorized(res, 'Too many attempts');

  const inputHash = sha256(code, OTP_PEPPER);
  if (inputHash !== otp.code_hash) {
    await supabase.from('otps').update({ attempts: otp.attempts + 1 }).eq('id', otp.id);
    return unauthorized(res, 'Invalid code');
  }

  // Consume OTP
  await supabase.from('otps').update({ consumed_at: new Date().toISOString() }).eq('id', otp.id);

  // Upsert user
  let user;
  let justCreated = false;
  {
    const { data: existing } = await supabase
      .from('users').select('*').eq('phone_e164', phone).maybeSingle();
    if (existing) {
      user = existing;
      await supabase.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', user.id);
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('users')
        .insert({ phone_e164: phone, display_name: null })
        .select('*').single();
      if (insErr) return serverError(res, 'Could not create user', insErr);
      user = inserted;
      justCreated = true;
      await supabase.from('user_settings').insert({ user_id: user.id });
    }
  }
  // "new" means either freshly inserted or a previous row that never completed profile
  const isNewUser = justCreated || !user.display_name;

  // Register device
  const pubKeyB64 = String(deviceInput.identity_public_key || '');
  const pubKeyBuffer = Buffer.from(pubKeyB64, 'base64');
  if (pubKeyBuffer.length < 16 || pubKeyBuffer.length > 256) {
    return badRequest(res, 'identity_public_key has unreasonable length');
  }
  const { deviceFingerprint } = require('../util/crypto');
  const fingerprint = deviceFingerprint(pubKeyBuffer);

  const { data: device, error: devErr } = await supabase.from('devices').insert({
    user_id: user.id,
    kind: deviceInput.kind,
    label: deviceInput.label || null,
    identity_public_key: pubKeyB64,
    fingerprint,
    user_agent: deviceInput.user_agent || req.headers['user-agent'] || null,
    ip_hint: req.socket?.remoteAddress || null,
  }).select('*').single();
  if (devErr) return serverError(res, 'Could not register device', devErr);

  // Issue tokens
  const accessToken = signAccess({ userId: user.id, deviceId: device.id });
  const refreshToken = randomBase64Url(48);
  const refreshHash = sha256(refreshToken);
  const refreshExpires = new Date(Date.now() + config.jwt.refreshTtl * 1000).toISOString();

  await supabase.from('sessions').insert({
    user_id: user.id,
    device_id: device.id,
    refresh_token_hash: refreshHash,
    expires_at: refreshExpires,
  });

  audit({
    userId: user.id, deviceId: device.id,
    action: 'auth.verify_otp', targetType: 'device', targetId: device.id,
    req,
  });

  created(res, {
    access_token: accessToken,
    refresh_token: refreshToken,
    is_new_user: isNewUser,
    user: sanitizeUser(user),
    device: sanitizeDevice(device),
  });
}

/**
 * POST /auth/refresh  { refresh_token }
 * Returns: { access_token, refresh_token }  (token rotation)
 */
async function refresh(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.refresh_token) return badRequest(res, 'refresh_token required');

  const hash = sha256(body.refresh_token);
  const { data: sess } = await supabase
    .from('sessions')
    .select('*')
    .eq('refresh_token_hash', hash)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!sess) return unauthorized(res, 'Invalid or expired refresh token');

  // Rotate
  const newToken = randomBase64Url(48);
  const newHash = sha256(newToken);
  await supabase.from('sessions').update({
    refresh_token_hash: newHash,
    last_used_at: new Date().toISOString(),
  }).eq('id', sess.id);

  const accessToken = signAccess({ userId: sess.user_id, deviceId: sess.device_id });
  ok(res, { access_token: accessToken, refresh_token: newToken });
}

/**
 * POST /auth/logout  (authed)
 * Revokes the current device's active sessions.
 */
async function logout(req, res) {
  const { deviceId } = req.auth;
  await supabase.from('sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('device_id', deviceId)
    .is('revoked_at', null);
  audit({ userId: req.auth.userId, deviceId, action: 'auth.logout', req });
  ok(res, { ok: true });
}

function sanitizeUser(u) {
  return {
    id: u.id,
    phone_e164: u.phone_e164,
    username: u.username,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    account_type: u.account_type,
    locale: u.locale,
    created_at: u.created_at,
  };
}

function sanitizeDevice(d) {
  return {
    id: d.id,
    kind: d.kind,
    label: d.label,
    fingerprint: d.fingerprint,
    enrolled_at: d.enrolled_at,
  };
}

module.exports = { requestOtp, verifyOtp, refresh, logout, sanitizeUser, sanitizeDevice };
