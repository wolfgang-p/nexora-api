'use strict';

const { Expo } = require('expo-server-sdk');
const { supabase } = require('../db/supabase');
const { deviceOnline } = require('../ws/dispatch');
const config = require('../config');

const expo = new Expo({ accessToken: config.push.expoAccessToken || undefined });

/**
 * Push to devices that aren't currently online via WebSocket.
 * Never includes plaintext — only envelope metadata.
 *
 * Options:
 *   - title/body/data: standard notification payload
 *   - category: 'message' (default) | 'call' | 'reminder'
 *   - silent: if true, sends a data-only push (iOS content-available=1,
 *     Android priority=high + no-notification) to wake the app without
 *     showing a system banner. Used for in-app badge refresh.
 *   - ttl: seconds before the provider drops the message (default 60 for
 *     calls, 4h for messages — stale pushes are worse than missing ones).
 */
async function pushToDevices(deviceIds, opts = {}) {
  const {
    title, body, data = {},
    category = 'message',
    silent = false,
    ttl,
    includeOnline = false,
  } = opts;
  if (!deviceIds?.length) return;

  const targets = includeOnline
    ? deviceIds
    : deviceIds.filter((id) => !deviceOnline(id));
  if (!targets.length) return;

  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('device_id, token, platform')
    .in('device_id', targets);
  if (!tokens?.length) return;

  const messages = [];
  for (const t of tokens) {
    if (!Expo.isExpoPushToken(t.token)) continue;
    const base = {
      to: t.token,
      data: { ...data, category, device_id: t.device_id },
      // Always high-priority so the OS wakes the app. Calls need it the most.
      priority: 'high',
      ttl: ttl ?? (category === 'call' ? 60 : 4 * 60 * 60),
      // Split channels so the user can mute messages but keep calls audible.
      channelId: category === 'call' ? 'calls' : category === 'reminder' ? 'reminders' : 'messages',
    };
    if (silent) {
      // Data-only on iOS + no notification on Android.
      messages.push({
        ...base,
        _contentAvailable: true, // maps to APNs content-available=1
        // Intentionally no title/body/sound.
      });
    } else {
      messages.push({
        ...base,
        title,
        body,
        sound: category === 'call' ? 'ringtone.caf' : 'default',
        // iOS: actionable category (Accept / Decline buttons) for calls.
        // The client registers this category name on startup.
        categoryId: category === 'call' ? 'KORO_CALL' : undefined,
      });
    }
  }
  if (!messages.length) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
          // Phone uninstalled or token expired — clean up so we don't keep
          // burning quota on dead endpoints.
          await supabase.from('push_tokens').delete().eq('token', chunk[i].to);
        }
      }
    } catch (err) {
      console.error('[push]', err?.message || err);
    }
  }
}

/**
 * Incoming-call ringer push. Delivered high-priority with a ringtone
 * category so the OS wakes the app and rings even when fully closed.
 *
 * For iOS we ALSO dispatch a parallel VoIP (PushKit) push for any
 * device that registered a `voip_token`. PushKit is the only way to
 * make CallKit ring while the app is fully killed; regular APNs only
 * wakes a backgrounded app. The VoIP path is best-effort — if APNs
 * isn't configured (no .p8 / cert on the server), we log and fall
 * through to the regular Expo push so nothing is lost.
 */
async function pushIncomingCall(deviceIds, { callId, conversationId, kind, fromName }) {
  // 1. Regular Expo push — same as before.
  const regular = pushToDevices(deviceIds, {
    title: fromName || 'Koro',
    body: kind === 'video' ? 'Eingehender Videoanruf' : 'Eingehender Anruf',
    category: 'call',
    ttl: 45, // old call notifications aren't useful; drop after 45s
    data: {
      type: 'call.incoming',
      call_id: callId,
      conversation_id: conversationId,
      kind,
    },
    includeOnline: true, // also ring devices that only have WS (may be backgrounded)
  });

  // 2. Parallel PushKit fan-out for iOS devices that registered a VoIP token.
  const voip = pushVoipCall(deviceIds, { callId, conversationId, kind, fromName });

  await Promise.allSettled([regular, voip]);
}

/**
 * Dispatch a VoIP (PushKit) push via APNs HTTP/2. Requires the operator
 * to configure an APNs auth key — same `.p8` they use for regular push,
 * just with a different topic (`<bundle-id>.voip`).
 *
 * Env vars (operator):
 *   APNS_KEY_ID         — 10-char Apple key id
 *   APNS_TEAM_ID        — 10-char Apple team id
 *   APNS_KEY_P8         — raw .p8 contents (newlines preserved)
 *   APNS_BUNDLE_ID      — e.g. "com.kyudev.koro"  (the .voip topic is
 *                         this + ".voip" automatically)
 *   APNS_PRODUCTION     — "1" for prod APNs, "0" for sandbox
 *
 * If any of these are missing we no-op silently. The regular Expo push
 * path still fires so users on backgrounded devices still ring.
 */
async function pushVoipCall(deviceIds, payload) {
  if (!deviceIds?.length) return;
  if (!process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID || !process.env.APNS_KEY_P8 || !process.env.APNS_BUNDLE_ID) {
    return; // not configured — silently skip
  }

  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('device_id, voip_token')
    .in('device_id', deviceIds)
    .not('voip_token', 'is', null);
  if (!tokens?.length) return;

  // Lazy-load the APNs HTTP/2 client so projects without the dep don't
  // explode at boot. Add to the API's package.json: "@parse/node-apn".
  let apn;
  try { apn = require('@parse/node-apn'); }
  catch { console.warn('[voip-push] @parse/node-apn not installed — skipping'); return; }

  const provider = new apn.Provider({
    token: {
      key: process.env.APNS_KEY_P8,
      keyId: process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID,
    },
    production: process.env.APNS_PRODUCTION === '1',
  });

  const note = new apn.Notification();
  note.topic = `${process.env.APNS_BUNDLE_ID}.voip`;
  note.pushType = 'voip';
  note.expiry = Math.floor(Date.now() / 1000) + 30; // 30s
  note.priority = 10;
  note.payload = {
    type: 'call.incoming',
    call_id: payload.callId,
    conversation_id: payload.conversationId,
    kind: payload.kind,
    from_name: payload.fromName || 'Koro',
  };

  try {
    const targets = tokens.map((t) => t.voip_token);
    const result = await provider.send(note, targets);
    for (const f of result.failed || []) {
      // Common: BadDeviceToken when a device reinstalls. Drop the
      // VoIP token so we don't keep retrying a dead one.
      if (f?.response?.reason === 'BadDeviceToken' || f?.status === '410') {
        await supabase.from('push_tokens').update({ voip_token: null }).eq('voip_token', f.device);
      }
    }
  } catch (err) {
    console.error('[voip-push]', err?.message || err);
  } finally {
    provider.shutdown();
  }
}

module.exports = { pushToDevices, pushIncomingCall };
