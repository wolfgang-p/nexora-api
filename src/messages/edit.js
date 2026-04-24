'use strict';

const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { broadcastToDevices } = require('../ws/dispatch');
const { envelopeFor } = require('./send');

const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 min

/**
 * PUT /messages/:id   (authed)
 *
 * Rewrites the per-recipient ciphertexts. Only the sender can edit, only
 * within 15 minutes of the original send, and only for kind='text'.
 *
 * Body:
 * {
 *   recipients: [{ device_id, ciphertext, nonce }, ...]   // new fanout
 * }
 *
 * Server does not see plaintext — it trusts the client to generate a new
 * ciphertext per recipient and just swaps the rows + stamps `edited_at`.
 */
async function editMessage(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return badRequest(res, 'recipients[] required');
  }

  const { data: msg } = await supabase
    .from('messages').select('*').eq('id', params.id).maybeSingle();
  if (!msg || msg.deleted_at) return notFound(res, 'Message not found');

  // Authorization: sender only.
  if (msg.sender_user_id !== req.auth.userId) {
    return forbidden(res, 'Only the sender can edit');
  }
  if (msg.sender_device_id !== req.auth.deviceId) {
    return forbidden(res, 'Edit must come from the sending device');
  }
  if (msg.kind !== 'text') return badRequest(res, 'Only text messages are editable');

  // Time window.
  const age = Date.now() - new Date(msg.created_at).getTime();
  if (age > EDIT_WINDOW_MS) return forbidden(res, 'Edit window (15 min) has passed');

  // Validate recipients against current conversation device set (same rule
  // as /messages send — we must not leak to someone who left the group).
  const { data: members } = await supabase
    .from('conversation_members').select('user_id')
    .eq('conversation_id', msg.conversation_id).is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id);
  if (!memberIds.length) return forbidden(res, 'No active members');

  const { data: allowedDevices } = await supabase
    .from('devices').select('id').in('user_id', memberIds).is('revoked_at', null);
  const allowed = new Set((allowedDevices || []).map((d) => d.id));

  const seen = new Set();
  for (const r of body.recipients) {
    if (!r?.device_id || !r?.ciphertext || !r?.nonce) {
      return badRequest(res, 'recipient must have device_id, ciphertext, nonce');
    }
    if (!allowed.has(r.device_id)) return forbidden(res, `Device ${r.device_id} is not a recipient`);
    if (seen.has(r.device_id)) return badRequest(res, 'Duplicate recipient device');
    seen.add(r.device_id);
  }

  // Swap the ciphertexts. We replace rather than upsert so old rows for
  // no-longer-members are purged.
  await supabase.from('message_recipients').delete().eq('message_id', msg.id);
  const rows = body.recipients.map((r) => ({
    message_id: msg.id,
    recipient_device_id: r.device_id,
    ciphertext: r.ciphertext,
    nonce: r.nonce,
  }));
  const { error: insErr } = await supabase.from('message_recipients').insert(rows);
  if (insErr) return serverError(res, 'Could not persist edited ciphertexts', insErr);

  const editedAt = new Date().toISOString();
  const { data: updated, error } = await supabase.from('messages')
    .update({ edited_at: editedAt })
    .eq('id', msg.id).select('*').single();
  if (error) return serverError(res, 'Could not mark message edited', error);

  // Broadcast to every recipient device so their UI swaps in the new
  // ciphertext + shows the "bearbeitet"-badge live.
  const deviceIds = body.recipients.map((r) => r.device_id);
  broadcastToDevices(deviceIds, (deviceId) => {
    const r = body.recipients.find((x) => x.device_id === deviceId);
    return {
      type: 'message.edited',
      message: envelopeFor(updated),
      ciphertext: r?.ciphertext || null,
      nonce: r?.nonce || null,
    };
  });

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'message.edit',
    targetType: 'message', targetId: msg.id,
    metadata: { conversation_id: msg.conversation_id },
    req,
  });

  ok(res, { message: envelopeFor(updated) });
}

module.exports = { editMessage };
