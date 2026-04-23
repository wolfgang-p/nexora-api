'use strict';

const { supabase } = require('../db/supabase');
const { ok, notFound } = require('../util/response');

/**
 * GET /pairing/sessions/:id   (no auth; the new device polls until completed)
 * Returns one of:
 *   { status: 'pending' }
 *   { status: 'claimed' }
 *   { status: 'completed', ciphertext, nonce, device_secret_ciphertext, device_secret_nonce, device_id, user_id }
 *   { status: 'expired' | 'cancelled' }
 */
async function pollPairing(req, res, { params }) {
  const { data: sess } = await supabase
    .from('pairing_sessions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!sess) return notFound(res, 'Pairing session not found');

  if (sess.cancelled_at) return ok(res, { status: 'cancelled' });
  if (sess.completed_at) {
    // Fetch the mobile (claiming) device's public key so the new web device
    // can decrypt the device secret that was sealed to the ephemeral public key
    // using the mobile device's secret key.
    let senderPublicKey = null;
    if (sess.claimed_by_device) {
      const { data: device } = await supabase
        .from('devices')
        .select('identity_public_key')
        .eq('id', sess.claimed_by_device)
        .maybeSingle();
      if (device) senderPublicKey = device.identity_public_key;
    }

    return ok(res, {
      status: 'completed',
      ciphertext: sess.ciphertext,
      nonce: sess.nonce,
      device_secret_ciphertext: sess.device_secret_ciphertext,
      device_secret_nonce: sess.device_secret_nonce,
      sender_public_key: senderPublicKey,
      device_id: sess.resulting_device_id,
      user_id: sess.claimed_by_user,
    });
  }
  if (new Date(sess.expires_at) < new Date()) return ok(res, { status: 'expired' });
  if (sess.claimed_by_user) return ok(res, { status: 'claimed' });
  return ok(res, { status: 'pending' });
}

module.exports = { pollPairing };
