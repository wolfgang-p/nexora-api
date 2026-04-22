'use strict';

const { supabase } = require('../db/supabase');
const { readJson, badRequest, ok, notFound, forbidden, serverError } = require('../util/response');
const { deviceFingerprint } = require('../util/crypto');
const { audit } = require('../util/audit');

/**
 * POST /pairing/sessions/:id/deliver   (authed as the claiming mobile user)
 *
 * The mobile device has encrypted the user's identity key to the new
 * device's ephemeral public key. We store ciphertext + nonce, and create
 * the new device row so it can start receiving fanout.
 *
 * Body: {
 *   ciphertext: b64,
 *   nonce: b64,
 *   new_device_public_key: b64      // the long-term per-device identity key
 * }
 */
async function deliverPairing(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.ciphertext || !body?.nonce || !body?.new_device_public_key) {
    return badRequest(res, 'ciphertext, nonce, new_device_public_key required');
  }

  const { data: sess } = await supabase
    .from('pairing_sessions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!sess) return notFound(res, 'Pairing session not found');
  if (sess.cancelled_at || sess.completed_at) return forbidden(res, 'Session closed');
  if (new Date(sess.expires_at) < new Date()) return forbidden(res, 'Session expired');
  if (!sess.claimed_by_user) return forbidden(res, 'Session not claimed');
  if (sess.claimed_by_user !== req.auth.userId) return forbidden(res, 'Not your session');

  const ciphertext = Buffer.from(body.ciphertext, 'base64');
  const nonce = Buffer.from(body.nonce, 'base64');
  const newPk = Buffer.from(body.new_device_public_key, 'base64');
  if (newPk.length < 16 || newPk.length > 256) {
    return badRequest(res, 'new_device_public_key has unreasonable length');
  }

  // Create the new device row (revocable, visible to owner)
  const { data: device, error: devErr } = await supabase.from('devices').insert({
    user_id: sess.claimed_by_user,
    kind: sess.new_device_kind,
    label: sess.new_device_label,
    identity_public_key: newPk,
    fingerprint: deviceFingerprint(newPk),
  }).select('id, fingerprint').single();
  if (devErr) return serverError(res, 'Could not register device', devErr);

  // Stamp the session
  const { error } = await supabase.from('pairing_sessions').update({
    ciphertext, nonce,
    resulting_device_id: device.id,
    completed_at: new Date().toISOString(),
  }).eq('id', params.id);
  if (error) return serverError(res, 'Could not finalize pairing', error);

  audit({
    userId: sess.claimed_by_user, deviceId: req.auth.deviceId,
    action: 'pairing.deliver',
    targetType: 'device', targetId: device.id,
    metadata: { session_id: params.id, new_device_fingerprint: device.fingerprint },
    req,
  });

  ok(res, { ok: true, device_id: device.id, fingerprint: device.fingerprint });
}

module.exports = { deliverPairing };
