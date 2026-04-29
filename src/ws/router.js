'use strict';

const { supabase } = require('../db/supabase');
const { broadcastToDevices, sendTo } = require('./dispatch');

/**
 * Route a single authenticated WS message from a client.
 *
 * Data-changing operations (message.send, reactions, etc.) go over HTTP —
 * WS is used for low-latency signals only: typing, presence, WebRTC signaling,
 * delivery / read acks.
 */
async function route(ws, data) {
  const { userId, deviceId } = ws.auth;

  switch (data.type) {
    case 'ping':
      return send(ws, { type: 'pong', t: Date.now() });

    case 'typing.start':
    case 'typing.stop': {
      // Look up the sender's device kind so receivers can render
      // "tippt auf iPhone…" instead of just "tippt…". Cached after
      // first hit per socket to avoid a DB round-trip on every keystroke.
      if (!ws._deviceKind) {
        const { data: d } = await supabase.from('devices').select('kind').eq('id', deviceId).maybeSingle();
        ws._deviceKind = d?.kind || 'unknown';
      }
      return forwardToConversation(data.conversation_id, userId, deviceId, {
        type: data.type,
        conversation_id: data.conversation_id,
        user_id: userId,
        device_kind: ws._deviceKind,
      });
    }

    // WebRTC signaling — relay to a specific peer device.
    // `webrtc.media-state` is sent when a peer toggles their mic or
    // camera mid-call so the other side can show an avatar instead of
    // a black RTCView when the camera goes off.
    case 'webrtc.offer':
    case 'webrtc.answer':
    case 'webrtc.ice':
    case 'webrtc.media-state':
      if (!data.target_device_id) return send(ws, { type: 'error', error: 'target_device_id required' });
      return sendTo(data.target_device_id, {
        type: data.type,
        call_id: data.call_id,
        from_device_id: deviceId,
        from_user_id: userId,
        payload: data.payload,
      });

    case 'presence.update':
      // Coarse presence: tell people sharing a conversation with me
      return updatePresence(userId, data.state || 'online');

    default:
      return send(ws, { type: 'error', error: `unknown_type: ${data.type}` });
  }
}

async function forwardToConversation(conversationId, senderUserId, senderDeviceId, payload) {
  if (!conversationId) return;
  // Sender must be a member
  const { data: me } = await supabase
    .from('conversation_members').select('user_id')
    .eq('conversation_id', conversationId).eq('user_id', senderUserId)
    .is('left_at', null).maybeSingle();
  if (!me) return;

  const { data: members } = await supabase
    .from('conversation_members').select('user_id')
    .eq('conversation_id', conversationId).is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id).filter((u) => u !== senderUserId);
  if (!memberIds.length) return;

  const { data: devices } = await supabase
    .from('devices').select('id').in('user_id', memberIds).is('revoked_at', null);
  broadcastToDevices((devices || []).map((d) => d.id), () => payload);
}

async function updatePresence(userId, state) {
  // Minimal: update last_seen. Real presence is a follow-up.
  if (state === 'online') {
    await supabase.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', userId);
  }
}

function send(ws, payload) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

module.exports = { route };
