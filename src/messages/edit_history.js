'use strict';

/**
 * Edit history — when a sender edits a message we record the prior
 * ciphertext (the sender's own copy, sealed to themselves) so they
 * can later see the original wording. Receivers don't need history;
 * the existing "edited" flag in the bubble footer is sufficient.
 *
 *   GET  /messages/:id/edits        — list prior versions for the sender
 *   POST /messages/:id/edits        — append a prior version
 *
 * Append is invoked by the existing edit endpoint (`messages/edit.js`).
 * The list endpoint is gated to the sender — receivers get 403.
 */

const { supabase } = require('../db/supabase');
const { ok, badRequest, forbidden, notFound, readJson, serverError } = require('../util/response');

async function append(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.ciphertext || !body?.nonce) return badRequest(res, 'ciphertext + nonce required');

  const { data: msg } = await supabase.from('messages')
    .select('id, sender_user_id').eq('id', params.id).maybeSingle();
  if (!msg) return notFound(res);
  if (msg.sender_user_id !== req.auth.userId) return forbidden(res, 'Only the sender can save edit history');

  const { data, error } = await supabase.from('message_edits').insert({
    message_id: params.id,
    ciphertext: body.ciphertext,
    nonce: body.nonce,
    sender_device_id: req.auth.deviceId,
  }).select('*').single();
  if (error) return serverError(res, 'Insert failed', error);
  ok(res, { edit: data });
}

async function list(req, res, { params }) {
  const { data: msg } = await supabase.from('messages')
    .select('id, sender_user_id').eq('id', params.id).maybeSingle();
  if (!msg) return notFound(res);
  if (msg.sender_user_id !== req.auth.userId) return forbidden(res, 'Only the sender may see edit history');

  const { data: edits } = await supabase.from('message_edits')
    .select('id, ciphertext, nonce, sender_device_id, edited_at')
    .eq('message_id', params.id)
    .order('edited_at', { ascending: false });
  ok(res, { edits: edits || [] });
}

module.exports = { append, list };
