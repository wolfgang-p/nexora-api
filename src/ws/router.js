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
        // Optional: when set, the receiver scopes this typing event to a
        // thread (so the main chat doesn't say "tippt…" for someone who
        // is just replying inside a thread, and vice versa).
        thread_root_id: data.thread_root_id || null,
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

    // In-call emoji burst — fan out to all OTHER participants of the
    // call. We use the call's conversation as the broadcast group;
    // it's the same authorization model as typing/messages.
    case 'call.reaction': {
      if (!data.call_id || typeof data.emoji !== 'string') {
        return send(ws, { type: 'error', error: 'call_id + emoji required' });
      }
      const { data: call } = await supabase.from('calls')
        .select('conversation_id').eq('id', data.call_id).maybeSingle();
      if (!call?.conversation_id) return;
      return forwardToConversation(call.conversation_id, userId, deviceId, {
        type: 'call.reaction',
        call_id: data.call_id,
        emoji: String(data.emoji).slice(0, 8),
        from_user_id: userId,
      });
    }

    case 'presence.update':
      // Coarse presence: tell people sharing a conversation with me
      return updatePresence(userId, data.state || 'online');

    // ── koro-meet signaling ────────────────────────────────────────────
    //
    // Three classes of message:
    //   meet.signal   — point-to-point WebRTC signaling (offer/answer/ice/
    //                   media-state). Routed by `target_device_id`.
    //   meet.broadcast — fan out to every other live participant of the
    //                    meeting. Used for chat, raise-hand, presence.
    //   meet.bye       — explicit leave; lets peers tear down faster than
    //                    waiting on the heartbeat.
    case 'meet.signal': {
      if (!data.target_device_id) return send(ws, { type: 'error', error: 'target_device_id required' });
      return sendTo(data.target_device_id, {
        type: 'meet.signal',
        meeting_id: data.meeting_id,
        signal: data.signal,             // 'offer'|'answer'|'ice'|'media-state'
        from_device_id: deviceId,
        from_user_id: userId,
        payload: data.payload,
      });
    }
    case 'meet.broadcast':
    case 'meet.bye': {
      if (!data.meeting_id) return send(ws, { type: 'error', error: 'meeting_id required' });
      return forwardToMeeting(data.meeting_id, deviceId, {
        type: data.type,
        meeting_id: data.meeting_id,
        from_device_id: deviceId,
        from_user_id: userId,
        // Subtype lets the client switch on chat/raise-hand/presence/etc.
        subtype: data.subtype || null,
        payload: data.payload,
      });
    }

    default:
      return send(ws, { type: 'error', error: `unknown_type: ${data.type}` });
  }
}

/**
 * Fan out a payload to every active (left_at IS NULL) participant of
 * a meeting EXCEPT the sender. Looks up the device handles in
 * `meeting_participants.device_id` (which is the same key our WS
 * registry uses — Koro device UUIDs for users, "meet:<uuid>" handles
 * for guests).
 */
async function forwardToMeeting(roomId, senderDeviceId, payload) {
  const { data: meeting } = await supabase.from('meetings')
    .select('id').eq('room_id', roomId).maybeSingle();
  if (!meeting) return;
  const { data: participants } = await supabase.from('meeting_participants')
    .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
  for (const p of participants || []) {
    if (p.device_id === senderDeviceId) continue;
    sendTo(p.device_id, payload);
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
