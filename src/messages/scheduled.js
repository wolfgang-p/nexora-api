'use strict';

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, notFound, forbidden, serverError } = require('../util/response');
const { audit } = require('../util/audit');

/**
 * POST /messages/scheduled   (authed)
 *
 * Pre-sealed E2E send that fires at `send_at`. The client builds the
 * normal per-device fanout right now (same as immediate send) and parks
 * it server-side; the scheduler worker inserts the real `messages` row
 * when the time comes. Server never sees plaintext.
 *
 * Body: {
 *   conversation_id, send_at, kind,
 *   reply_to_message_id?,
 *   recipients: [{device_id, ciphertext, nonce}, ...]
 * }
 */
async function create(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const {
    conversation_id: convId,
    send_at: sendAtRaw,
    kind = 'text',
    reply_to_message_id: replyTo = null,
    recipients,
  } = body;

  if (!convId) return badRequest(res, 'conversation_id required');
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return badRequest(res, 'recipients[] required');
  }
  if (recipients.length > 500) return badRequest(res, 'too many recipients');

  const sendAt = new Date(sendAtRaw);
  if (Number.isNaN(sendAt.getTime())) return badRequest(res, 'invalid send_at');
  if (sendAt.getTime() < Date.now() + 15_000) {
    return badRequest(res, 'send_at must be at least 15 s in the future');
  }
  if (sendAt.getTime() > Date.now() + 365 * 86400_000) {
    return badRequest(res, 'send_at more than 1 year out');
  }

  // Sender must be a live member
  const { data: me } = await supabase
    .from('conversation_members').select('role')
    .eq('conversation_id', convId).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me) return forbidden(res, 'not a conversation member');

  // Validate structure; we don't need to re-validate devices, because the
  // actual send at due-time will re-check against live membership.
  for (const r of recipients) {
    if (!r?.device_id || !r?.ciphertext || !r?.nonce) {
      return badRequest(res, 'recipient must have device_id, ciphertext, nonce');
    }
  }

  const row = {
    sender_user_id: req.auth.userId,
    sender_device_id: req.auth.deviceId,
    conversation_id: convId,
    send_at: sendAt.toISOString(),
    kind,
    recipients,
    reply_to_message_id: replyTo,
  };
  const { data, error } = await supabase.from('scheduled_messages').insert(row).select('*').single();
  if (error) return serverError(res, 'Schedule failed', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'message.schedule', targetType: 'scheduled_message', targetId: data.id,
    metadata: { conversation_id: convId, send_at: row.send_at }, req,
  });

  // Don't leak the big ciphertext blob back to the client
  const { recipients: _r, ...sanitized } = data;
  created(res, { scheduled: { ...sanitized, recipient_count: recipients.length } });
}

/** GET /messages/scheduled?conversation_id= */
async function list(req, res, { query }) {
  let q = supabase.from('scheduled_messages')
    .select('id, conversation_id, send_at, kind, reply_to_message_id, created_at, canceled_at, sent_at, last_error')
    .eq('sender_user_id', req.auth.userId)
    .is('sent_at', null).is('canceled_at', null)
    .order('send_at', { ascending: true });
  if (query.conversation_id) q = q.eq('conversation_id', query.conversation_id);
  const { data, error } = await q;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { scheduled: data || [] });
}

/** DELETE /messages/scheduled/:id — cancel a pending scheduled message. */
async function destroy(req, res, { params }) {
  const { data: row } = await supabase.from('scheduled_messages').select('*')
    .eq('id', params.id).eq('sender_user_id', req.auth.userId).maybeSingle();
  if (!row) return notFound(res, 'Not found');
  if (row.sent_at) return badRequest(res, 'already sent');
  await supabase.from('scheduled_messages').update({
    canceled_at: new Date().toISOString(),
  }).eq('id', params.id);
  ok(res, { ok: true });
}

module.exports = { create, list, destroy };
