'use strict';

const { supabase } = require('../db/supabase');
const { readJson, badRequest, ok, notFound, forbidden, serverError } = require('../util/response');
const { audit } = require('../util/audit');

/**
 * POST /pairing/sessions/:id/claim   (authed as mobile user)
 * Body: { pairing_code }
 * Marks session as claimed by this user+device. One-shot.
 */
async function claimPairing(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  const bodyPairingCode = body?.pairing_code;

  let sess = null;

  // Try pairing_code first (short code like K9HJD)
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
  if (sess.claimed_by_user) return forbidden(res, 'Session already claimed');

  // If pairing code was provided in body, validate it
  if (bodyPairingCode && sess.pairing_code !== bodyPairingCode) {
    return forbidden(res, 'Invalid pairing code');
  }

  const { error } = await supabase.from('pairing_sessions').update({
    claimed_by_user: req.auth.userId,
    claimed_by_device: req.auth.deviceId,
  }).eq('id', params.id);
  if (error) return serverError(res, 'Could not claim session', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'pairing.claim', targetType: 'pairing_session', targetId: params.id, req,
  });

  ok(res, {
    ok: true,
    new_device_kind: sess.new_device_kind,
    new_device_label: sess.new_device_label,
    ephemeral_public_key: sess.ephemeral_public_key,
  });
}

module.exports = { claimPairing };
