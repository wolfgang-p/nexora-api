'use strict';

const { supabase } = require('../db/supabase');
const { sha256, otpCode, randomBase64Url } = require('../util/crypto');
const { signAccess } = require('./jwt');
const { audit } = require('../util/audit');
const { readJson, ok, created, badRequest, unauthorized, forbidden, serverError } = require('../util/response');
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
 * App-Store / Play-Store review account. Returns true if this is the
 * whitelisted review phone AND a fixed review OTP is configured. Used to skip
 * SMS sending and to accept the fixed code on verify. Inactive unless BOTH
 * REVIEW_PHONE and REVIEW_OTP env vars are set.
 */
function isReviewPhone(phone) {
  return !!(config.review.phone && config.review.otp && phone === config.review.phone);
}

/**
 * POST /auth/request-otp   { phone_e164 }
 */
async function requestOtp(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const phone = normalizePhone(body.phone_e164 || body.phone_number);
  if (!phone) return badRequest(res, 'Invalid phone number (E.164 required)');

  // Review account: never send an SMS, never write an OTP row. The fixed code
  // is accepted directly in verifyOtp. Respond as if the code was sent.
  if (isReviewPhone(phone)) {
    return ok(res, { ok: true, expires_in: OTP_TTL_SECONDS });
  }

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

  // Review account: accept the fixed code without touching the otps table.
  // Everything below (ban check, user upsert, token issuance) runs normally,
  // so the reviewer gets a real, fully-functional session.
  const isReview = isReviewPhone(phone);
  if (isReview) {
    if (code !== config.review.otp) return unauthorized(res, 'Invalid code');
  } else {
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
  }

  // Reject if this phone OR this device's identity_public_key is on the
  // fingerprint blocklist — a banned user can't re-register by rotating
  // the device, and a banned device can't pivot to a different number.
  //
  // The review number is exempt: Apple's reviewer deletes the demo account and
  // must sign back in with the same number to test the next build. deleteMe
  // already avoids banning it; this skip is a safeguard for any stale ban row.
  const phoneHash = sha256(phone);
  const pubKeyB64 = String(deviceInput.identity_public_key || '');
  if (!isReview) {
    const { data: bans } = await supabase
      .from('banned_fingerprints')
      .select('id')
      .or(`phone_hash.eq.${phoneHash},device_public_key.eq.${pubKeyB64}`)
      .limit(1);
    if (bans && bans.length > 0) {
      return forbidden(res, 'Account banned');
    }
  }

  // Upsert user
  let user;
  let justCreated = false;
  {
    const { data: existing } = await supabase
      .from('users').select('*').eq('phone_e164', phone).maybeSingle();
    if (existing) {
      user = existing;
      const patch = { last_seen_at: new Date().toISOString() };
      if (!user.phone_hash) {
        // Back-fill phone_hash for users that existed before migration 0008.
        patch.phone_hash = sha256(phone);
        user.phone_hash = patch.phone_hash;
      }
      await supabase.from('users').update(patch).eq('id', user.id);
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('users')
        .insert({
          phone_e164: phone,
          phone_hash: sha256(phone), // pepper-less hash for contacts discovery
          display_name: null,
        })
        .select('*').single();
      if (insErr) return serverError(res, 'Could not create user', insErr);
      user = inserted;
      justCreated = true;
      await supabase.from('user_settings').insert({ user_id: user.id });
    }
  }
  // "new" means either freshly inserted or a previous row that never completed profile
  const isNewUser = justCreated || !user.display_name;

  // Register device (pubKeyB64 already validated against blocklist above)
  const pubKeyBuffer = Buffer.from(pubKeyB64, 'base64');
  if (pubKeyBuffer.length < 16 || pubKeyBuffer.length > 256) {
    return badRequest(res, 'identity_public_key has unreasonable length');
  }
  const { deviceFingerprint } = require('../util/crypto');
  const fingerprint = deviceFingerprint(pubKeyBuffer);

  // REUSE the existing device for this (user, identity_public_key) instead of
  // always inserting a new one. The mobile client keeps the SAME device keypair
  // across logout/re-login (it never wipes the private key), so re-login must
  // land on the SAME device_id — otherwise historical message ciphertexts (which
  // are addressed per device_id) can't be opened and every old message shows as
  // "not decryptable". Only insert a fresh row when no matching device exists.
  let device;
  {
    const { data: existing } = await supabase
      .from('devices')
      .select('*')
      .eq('user_id', user.id)
      .eq('identity_public_key', pubKeyB64)
      .is('revoked_at', null)
      .order('enrolled_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      // Refresh mutable metadata; keep the same id + fingerprint + history binding.
      const { data: updated } = await supabase
        .from('devices')
        .update({
          kind: deviceInput.kind,
          label: deviceInput.label || existing.label || null,
          user_agent: deviceInput.user_agent || req.headers['user-agent'] || existing.user_agent || null,
          ip_hint: req.socket?.remoteAddress || existing.ip_hint || null,
          last_seen_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      device = updated || existing;
    } else {
      const { data: created, error: devErr } = await supabase.from('devices').insert({
        user_id: user.id,
        kind: deviceInput.kind,
        label: deviceInput.label || null,
        identity_public_key: pubKeyB64,
        fingerprint,
        user_agent: deviceInput.user_agent || req.headers['user-agent'] || null,
        ip_hint: req.socket?.remoteAddress || null,
      }).select('*').single();
      if (devErr) return serverError(res, 'Could not register device', devErr);
      device = created;
    }
  }

  // 2FA gate — if this user has TOTP enabled, don't issue a session.
  // Instead, return a short-lived login_token; the client must POST to
  // /auth/totp/verify with a valid code to get the actual tokens.
  if (user.totp_enabled) {
    const { signLoginChallenge } = require('./jwt');
    const loginToken = signLoginChallenge({ userId: user.id, phone });
    audit({
      userId: user.id, deviceId: device.id,
      action: 'auth.verify_otp.totp_required', targetType: 'device', targetId: device.id, req,
    });
    return ok(res, {
      pending_totp: true,
      login_token: loginToken,
      device: sanitizeDevice(device),
      // Echo user info so the client can show "Hi, name" on the 2FA screen.
      user: sanitizeUser(user),
    });
  }

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

  // Login-history row (best-effort, non-blocking).
  const { recordLogin } = require('./loginHistory');
  recordLogin({ userId: user.id, deviceId: device.id, mode: 'otp', req }).catch(() => {});

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
 *
 * Token rotation with theft detection:
 *   - Valid token (row exists, not rotated, not revoked, not expired) →
 *     mint a new refresh_token + access_token, mark old row rotated_at=now,
 *     insert a new row, return both.
 *   - Token reuse (row exists, rotated_at IS NOT NULL) →
 *     SOMEONE else rotated this already. Treat as theft: revoke every
 *     live session of this user, 401.
 *   - Unknown token → 401.
 *
 * Sliding window: each successful rotation extends the expiry by
 * JWT_REFRESH_TTL seconds, so a user who opens the app regularly stays
 * signed in indefinitely. Absent activity for longer than the TTL
 * (default 30 days) forces re-login.
 */
const ROTATION_GRACE_DAYS = 7;

// Legacy fallback only. Rotated rows created before migration 0032 have no
// recorded successor, so we can't hand the successor back idempotently. For
// those we still fall back to a (now generous) time-based grace so a lost
// response doesn't log the user out. New rows never hit this path — they use
// the stored successor instead, which is time-unbounded and fully recoverable.
const REUSE_GRACE_SECONDS = 7 * 86400; // 7 days

async function refresh(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.refresh_token) return badRequest(res, 'refresh_token required');

  const hash = sha256(body.refresh_token);

  // Look up across ALL session rows, including rotated ones, to catch reuse.
  const { data: sess } = await supabase
    .from('sessions')
    .select('*')
    .eq('refresh_token_hash', hash)
    .maybeSingle();

  if (!sess) return unauthorized(res, 'Invalid refresh token');

  // THE PRESENTED TOKEN WAS ALREADY ROTATED OUT.
  //
  // This is the crux of "I get logged out after a while and then can't decrypt
  // my messages". Almost always it is NOT theft: the server rotated the token
  // and minted a successor, but the client never received the response (network
  // dropped, app backgrounded mid-flight) and still holds the old token. On the
  // next app open — seconds OR many days later — it presents that old token.
  //
  // Idempotent recovery: we recorded which successor this row minted
  // (successor_token_hash). If that successor is still the CURRENT live token
  // (not itself rotated, not revoked, not expired), the client simply lost the
  // response — so we hand the SAME successor back. No time limit, no revoke,
  // fully recoverable. Only a genuine fork in the rotation chain (the successor
  // was itself already rotated onward by someone else) is treated as theft.
  if (sess.rotated_at) {
    const rotatedAgoMs = Date.now() - new Date(sess.rotated_at).getTime();

    // Preferred path (rows from migration 0032 onward): walk the successor chain
    // this token started to its live tip.
    //
    // The client may have lost SEVERAL responses in a row (each rotation minted a
    // successor the client never saw). Presenting any ancestor token must still
    // recover the account, so we follow successor_token_hash forward until we
    // reach either the live tip (rotate it forward, return that — idempotent) or
    // a revoked row (genuine theft — the chain was locked out already).
    if (sess.successor_token_hash) {
      let node = sess;
      let tip = null;          // the live (non-rotated) row at the end of the chain
      let revoked = false;     // chain ran into a revoked row → theft
      const MAX_HOPS = 64;     // safety bound; real chains are 1–2 hops
      for (let hop = 0; hop < MAX_HOPS && node.successor_token_hash; hop++) {
        const { data: next } = await supabase
          .from('sessions')
          .select('*')
          .eq('refresh_token_hash', node.successor_token_hash)
          .maybeSingle();
        if (!next) break;            // pruned — fall through to time-based grace
        if (next.revoked_at) { revoked = true; break; }
        if (!next.rotated_at) { tip = next; break; } // reached the live tip
        node = next;                 // keep walking
      }

      if (tip && new Date(tip.expires_at) >= new Date()) {
        // Ancestor of the current live token → the client lost our earlier
        // response(s). Rotate the live tip forward one step and return THAT, so
        // the client continues exactly where it left off. No logout, no
        // re-login, history stays readable. Single-use + idempotent: another
        // lost response just walks the chain again and repeats this safely.
        const chainedToken = randomBase64Url(48);
        const chainedHash = sha256(chainedToken);
        const chainedExpires = new Date(Date.now() + config.jwt.refreshTtl * 1000).toISOString();

        await supabase.from('sessions').update({
          rotated_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
          successor_token_hash: chainedHash,
        }).eq('id', tip.id);

        const { error: chainErr } = await supabase.from('sessions').insert({
          user_id: tip.user_id,
          device_id: tip.device_id,
          refresh_token_hash: chainedHash,
          expires_at: chainedExpires,
        });
        if (chainErr) return serverError(res, 'Could not recover session', chainErr);

        audit({
          userId: sess.user_id, deviceId: sess.device_id,
          action: 'auth.refresh.lost_response_recovered',
          targetType: 'session', targetId: sess.id,
          metadata: { rotated_ago_ms: rotatedAgoMs },
          req,
        });
        const accessToken = signAccess({ userId: tip.user_id, deviceId: tip.device_id });
        return ok(res, { access_token: accessToken, refresh_token: chainedToken });
      }

      // The chain led to a revoked row → this device's sessions were already
      // locked out (genuine theft, or an explicit logout). Re-affirm the revoke.
      if (revoked) {
        await supabase.from('sessions')
          .update({ revoked_at: new Date().toISOString() })
          .eq('user_id', sess.user_id)
          .is('revoked_at', null);
        audit({
          userId: sess.user_id, deviceId: sess.device_id,
          action: 'auth.refresh.reuse_detected',
          targetType: 'session', targetId: sess.id,
          metadata: { ip: req.socket?.remoteAddress || null, reason: 'chain_revoked' },
          req,
        });
        return unauthorized(res, 'Refresh token reuse detected — all sessions revoked', { code: 'session_revoked' });
      }
      // Live tip is expired, or the chain was pruned before reaching a live row
      // → fall through to the time-based grace / expiry handling below.
    }

    // Legacy fallback (pre-0032 rows without a stored successor). We can't
    // replay a successor we never recorded, so use a generous time-based grace:
    // a recently-rotated token is treated as a benign lost-response retry (soft
    // 401, no revoke — the client keeps its tokens and retries). Only a very old
    // rotated token is treated as genuine theft.
    if (rotatedAgoMs <= REUSE_GRACE_SECONDS * 1000) {
      audit({
        userId: sess.user_id, deviceId: sess.device_id,
        action: 'auth.refresh.retry_grace',
        targetType: 'session', targetId: sess.id,
        metadata: { rotated_ago_ms: rotatedAgoMs },
        req,
      });
      return unauthorized(res, 'Refresh token already rotated — retry');
    }

    await supabase.from('sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', sess.user_id)
      .is('revoked_at', null);
    audit({
      userId: sess.user_id, deviceId: sess.device_id,
      action: 'auth.refresh.reuse_detected',
      targetType: 'session', targetId: sess.id,
      metadata: { ip: req.socket?.remoteAddress || null, rotated_ago_ms: rotatedAgoMs },
      req,
    });
    return unauthorized(res, 'Refresh token reuse detected — all sessions revoked', { code: 'session_revoked' });
  }

  if (sess.revoked_at) return unauthorized(res, 'Session revoked');
  if (new Date(sess.expires_at) < new Date()) {
    return unauthorized(res, 'Session expired');
  }

  // Rotate: mint a new token, insert a new row, mark the old one rotated AND
  // record the successor hash so a lost response can be recovered idempotently
  // (see the rotated-token branch above).
  const newToken = randomBase64Url(48);
  const newHash = sha256(newToken);
  const newExpires = new Date(Date.now() + config.jwt.refreshTtl * 1000).toISOString();

  await supabase.from('sessions').update({
    rotated_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
    successor_token_hash: newHash,
  }).eq('id', sess.id);

  const { error: insertErr } = await supabase.from('sessions').insert({
    user_id: sess.user_id,
    device_id: sess.device_id,
    refresh_token_hash: newHash,
    expires_at: newExpires,
  });
  if (insertErr) return serverError(res, 'Could not rotate session', insertErr);

  // Lazy prune: rotated rows older than the grace window aren't useful
  // anymore (theft detection only cares about recent replays).
  const prune = new Date(Date.now() - ROTATION_GRACE_DAYS * 86400_000).toISOString();
  supabase.from('sessions').delete()
    .eq('device_id', sess.device_id)
    .not('rotated_at', 'is', null)
    .lt('rotated_at', prune)
    .then(() => {}, () => {});

  const accessToken = signAccess({ userId: sess.user_id, deviceId: sess.device_id });
  ok(res, { access_token: accessToken, refresh_token: newToken });
}

/**
 * POST /auth/logout  (authed)
 * Revokes the current device's active sessions.
 */
async function logout(req, res) {
  const { deviceId } = req.auth;
  // Revoke every live (non-rotated, non-revoked) session for this device.
  await supabase.from('sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('device_id', deviceId)
    .is('revoked_at', null)
    .is('rotated_at', null);
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
    is_admin: !!u.is_admin,
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
