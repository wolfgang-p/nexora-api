'use strict';

const { supabase } = require('../db/supabase');
const { ok, notFound, forbidden, serverError } = require('../util/response');
const { signAccess } = require('../auth/jwt');
const { randomBase64Url, sha256 } = require('../util/crypto');
const config = require('../config');

/**
 * GET /pairing/sessions/:id/token   (no auth)
 * After pairing is completed, the new device can fetch its access/refresh tokens.
 * This is a one-shot endpoint — tokens are only issued once, tied to the resulting device.
 */
async function getPairingToken(req, res, { params }) {
  const { data: sess } = await supabase
    .from('pairing_sessions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!sess) return notFound(res, 'Pairing session not found');

  console.log('[Pairing] Token request for session:', {
    id: params.id,
    completed_at: sess.completed_at,
    token_issued_at: sess.token_issued_at,
    resulting_device_id: sess.resulting_device_id,
    claimed_by_user: sess.claimed_by_user,
  });

  if (!sess.completed_at) return forbidden(res, 'Pairing not completed');
  if (sess.token_issued_at) return forbidden(res, 'Token already issued');

  const deviceId = sess.resulting_device_id;
  const userId = sess.claimed_by_user;
  if (!deviceId || !userId) return forbidden(res, 'Incomplete pairing session');

  // Issue tokens
  const accessToken = signAccess({ userId, deviceId });
  const refreshToken = randomBase64Url(48);
  const refreshHash = sha256(refreshToken);
  const refreshExpires = new Date(Date.now() + config.jwt.refreshTtl * 1000).toISOString();

  const { error: sessErr } = await supabase.from('sessions').insert({
    user_id: userId,
    device_id: deviceId,
    refresh_token_hash: refreshHash,
    expires_at: refreshExpires,
  });
  if (sessErr) {
    console.error('[Pairing] Session insert failed:', sessErr);
    return serverError(res, 'Could not create session', sessErr);
  }

  // Mark token as issued so it's not re-issued
  const { error: updateErr } = await supabase.from('pairing_sessions').update({
    token_issued_at: new Date().toISOString(),
  }).eq('id', params.id);
  if (updateErr) {
    console.error('[Pairing] Mark token issued failed:', updateErr);
    return serverError(res, 'Could not mark token issued', updateErr);
  }

  ok(res, {
    access_token: accessToken,
    refresh_token: refreshToken,
    device_secret_ciphertext: sess.device_secret_ciphertext,
    device_secret_nonce: sess.device_secret_nonce,
  });
}

module.exports = { getPairingToken };
