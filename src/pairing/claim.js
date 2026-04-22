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
  if (!body?.pairing_code) return badRequest(res, 'pairing_code required');

  const { data: sess } = await supabase
    .from('pairing_sessions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!sess) return notFound(res, 'Pairing session not found');
  if (sess.cancelled_at || sess.completed_at) return forbidden(res, 'Session closed');
  if (new Date(sess.expires_at) < new Date()) return forbidden(res, 'Session expired');
  if (sess.claimed_by_user) return forbidden(res, 'Session already claimed');
  if (sess.pairing_code !== body.pairing_code) return forbidden(res, 'Invalid pairing code');

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
    ephemeral_public_key: Buffer.from(sess.ephemeral_public_key).toString('base64'),
  });
}

module.exports = { claimPairing };
