'use strict';

const { supabase } = require('../db/supabase');
const { readJson, badRequest, ok, notFound, forbidden, serverError } = require('../util/response');
const { deviceFingerprint } = require('../util/crypto');
const { audit } = require('../util/audit');

/**
 * POST /pairing/sessions/:id/deliver   (authed as the claiming mobile user)
 *
 * The mobile device encrypts:
 * 1. Its own device secret key (for message history sync) to ephemeral_public_key
 * 2. Provides its identity_public_key for the new device registration
 *
 * We store encrypted secret + nonce and create the new device row.
 *
 * Body: {
 *   identity_public_key: b64,               // the long-term per-device identity key
 *   device_secret_ciphertext: b64,          // encrypted device secret
 *   device_secret_nonce: b64
 * }
 */
async function deliverPairing(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.identity_public_key) {
    return badRequest(res, 'identity_public_key required');
  }

  let sess = null;

  // Try pairing_code first (short code like AAEAB)
  if (!params.id.includes('-')) {
    const { data } = await supabase
      .from('pairing_sessions')
      .select('*')
      .eq('pairing_code', params.id)
      .maybeSingle();
    sess = data;
  }

  // If not found, try as session ID (UUID)
  if (!sess && params.id.includes('-')) {
    const { data } = await supabase
      .from('pairing_sessions')
      .select('*')
      .eq('id', params.id)
      .maybeSingle();
    sess = data;
  }

  if (!sess) return notFound(res, 'Pairing session not found');
  if (sess.cancelled_at || sess.completed_at) return forbidden(res, 'Session closed');
  if (new Date(sess.expires_at) < new Date()) return forbidden(res, 'Session expired');
  if (!sess.claimed_by_user) return forbidden(res, 'Session not claimed');
  if (sess.claimed_by_user !== req.auth.userId) return forbidden(res, 'Not your session');

  const pkBuf = Buffer.from(body.identity_public_key, 'base64');
  if (pkBuf.length < 16 || pkBuf.length > 256) {
    return badRequest(res, 'identity_public_key has unreasonable length');
  }

  // Validate encrypted device secret (for message history sync)
  if (!body.device_secret_ciphertext || !body.device_secret_nonce) {
    return badRequest(res, 'device_secret_ciphertext and device_secret_nonce required');
  }

  // Create the new device row (revocable, visible to owner)
  const { data: device, error: devErr } = await supabase.from('devices').insert({
    user_id: sess.claimed_by_user,
    kind: sess.new_device_kind,
    label: sess.new_device_label,
    identity_public_key: body.identity_public_key,
    fingerprint: deviceFingerprint(pkBuf),
  }).select('id, fingerprint').single();
  if (devErr) return serverError(res, 'Could not register device', devErr);

  // Stamp the session and store encrypted device secret for history sync
  const { error } = await supabase.from('pairing_sessions').update({
    resulting_device_id: device.id,
    completed_at: new Date().toISOString(),
    device_secret_ciphertext: body.device_secret_ciphertext,
    device_secret_nonce: body.device_secret_nonce,
  }).eq('id', sess.id);
  if (error) return serverError(res, 'Could not finalize pairing', error);

  audit({
    userId: sess.claimed_by_user, deviceId: req.auth.deviceId,
    action: 'pairing.deliver',
    targetType: 'device', targetId: device.id,
    metadata: { session_id: sess.id, new_device_fingerprint: device.fingerprint },
    req,
  });

  ok(res, { ok: true, device_id: device.id, fingerprint: device.fingerprint });
}

module.exports = { deliverPairing };
