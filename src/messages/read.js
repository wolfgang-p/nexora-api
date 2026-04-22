'use strict';

const { supabase } = require('../db/supabase');
const { ok, notFound } = require('../util/response');
const { broadcastToDevices } = require('../ws/dispatch');

/**
 * POST /messages/:id/delivered  — mark this device's copy as delivered
 */
async function markDelivered(req, res, { params }) {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('message_recipients')
    .update({ delivered_at: now })
    .eq('message_id', params.id)
    .eq('recipient_device_id', req.auth.deviceId)
    .is('delivered_at', null)
    .select('message_id').maybeSingle();

  if (!data) return notFound(res, 'No pending recipient row');

  // Tell the sender's devices
  await notifySender(params.id, { type: 'message.delivered', message_id: params.id, by_device: req.auth.deviceId });
  ok(res, { ok: true });
}

/**
 * POST /messages/:id/read  — mark this device's copy as read
 */
async function markRead(req, res, { params }) {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('message_recipients')
    .update({ read_at: now, delivered_at: now })
    .eq('message_id', params.id)
    .eq('recipient_device_id', req.auth.deviceId)
    .select('message_id').maybeSingle();

  if (!data) return notFound(res, 'No recipient row');

  // Update conversation_members.last_read pointer
  const { data: msg } = await supabase
    .from('messages').select('conversation_id').eq('id', params.id).maybeSingle();
  if (msg) {
    await supabase.from('conversation_members').update({
      last_read_message_id: params.id,
      last_read_at: now,
    }).eq('conversation_id', msg.conversation_id).eq('user_id', req.auth.userId);
  }

  await notifySender(params.id, { type: 'message.read', message_id: params.id, by_user: req.auth.userId });
  ok(res, { ok: true });
}

async function notifySender(messageId, payload) {
  const { data: msg } = await supabase
    .from('messages').select('sender_user_id').eq('id', messageId).maybeSingle();
  if (!msg) return;
  const { data: devices } = await supabase
    .from('devices').select('id').eq('user_id', msg.sender_user_id).is('revoked_at', null);
  if (!devices) return;
  broadcastToDevices(devices.map((d) => d.id), () => payload);
}

module.exports = { markDelivered, markRead };
