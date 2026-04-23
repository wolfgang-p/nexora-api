'use strict';

const { supabase } = require('../db/supabase');
const { broadcastToDevices } = require('../ws/dispatch');

/**
 * Resolve a user id → display label ({id, name}) for use inside a system
 * payload. Falls back to username, then "Unknown". Best-effort.
 */
async function fetchLabel(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from('users')
    .select('id, display_name, username')
    .eq('id', userId)
    .maybeSingle();
  if (!data) return { id: userId, name: 'Unknown' };
  const name = data.display_name || (data.username ? '@' + data.username : null) || 'Unknown';
  return { id: data.id, name };
}

async function fetchLabels(userIds) {
  if (!userIds?.length) return [];
  const { data } = await supabase
    .from('users')
    .select('id, display_name, username')
    .in('id', userIds);
  const map = new Map();
  for (const u of data || []) {
    map.set(u.id, u.display_name || (u.username ? '@' + u.username : null) || 'Unknown');
  }
  return userIds.map((id) => ({ id, name: map.get(id) || 'Unknown' }));
}

/**
 * Emit a system message on a conversation: inserts a messages row with
 * kind='system' + system_payload, and broadcasts via WS so all devices
 * render it immediately.
 */
async function emitSystemMessage({ conversationId, actorUserId, actorDeviceId, payload }) {
  const { data: msg, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_user_id: actorUserId,
      sender_device_id: actorDeviceId,
      kind: 'system',
      system_payload: payload,
    })
    .select('*')
    .single();
  if (error || !msg) return null;

  const { data: members } = await supabase
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id);
  if (!memberIds.length) return msg;

  const { data: devices } = await supabase
    .from('devices')
    .select('id')
    .in('user_id', memberIds)
    .is('revoked_at', null);

  broadcastToDevices((devices || []).map((d) => d.id), () => ({
    type: 'message.new',
    message: {
      id: msg.id,
      conversation_id: msg.conversation_id,
      sender_user_id: msg.sender_user_id,
      sender_device_id: msg.sender_device_id,
      kind: 'system',
      reply_to_message_id: null,
      media_object_id: null,
      system_payload: msg.system_payload,
      created_at: msg.created_at,
      edited_at: null,
      deleted_at: null,
    },
    ciphertext: null,
    nonce: null,
  }));

  return msg;
}

module.exports = { emitSystemMessage, fetchLabel, fetchLabels };
