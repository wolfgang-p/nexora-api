'use strict';

const { supabase } = require('../db/supabase');
const { ok, notFound, forbidden } = require('../util/response');
const { audit } = require('../util/audit');
const { broadcastToDevices } = require('../ws/dispatch');

/**
 * DELETE /messages/:id
 * Sender can always delete their own message. Conversation admins can also
 * delete any message in their conversation.
 */
async function deleteMessage(req, res, { params }) {
  const { data: msg } = await supabase
    .from('messages').select('*').eq('id', params.id).maybeSingle();
  if (!msg || msg.deleted_at) return notFound(res, 'Message not found');

  let canDelete = msg.sender_user_id === req.auth.userId;
  if (!canDelete) {
    const { data: me } = await supabase
      .from('conversation_members')
      .select('role').eq('conversation_id', msg.conversation_id)
      .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
    canDelete = me && ['owner', 'admin'].includes(me.role);
  }
  if (!canDelete) return forbidden(res, 'Not allowed');

  const now = new Date().toISOString();
  await supabase.from('messages').update({
    deleted_at: now,
    deleted_by_user_id: req.auth.userId,
    kind: 'deleted',
  }).eq('id', params.id);

  // Wipe ciphertexts to truly remove content (recipients keep empty rows to track IDs)
  await supabase.from('message_recipients').update({
    ciphertext: '',
    nonce: '',
  }).eq('message_id', params.id);

  // Notify every active member device
  const { data: members } = await supabase
    .from('conversation_members')
    .select('user_id').eq('conversation_id', msg.conversation_id).is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id);
  const { data: devices } = await supabase
    .from('devices').select('id').in('user_id', memberIds).is('revoked_at', null);
  broadcastToDevices((devices || []).map((d) => d.id), () => ({
    type: 'message.deleted',
    message_id: params.id,
    conversation_id: msg.conversation_id,
  }));

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'message.delete',
    targetType: 'message', targetId: params.id,
    metadata: { conversation_id: msg.conversation_id },
    req,
  });

  ok(res, { ok: true });
}

module.exports = { deleteMessage };
