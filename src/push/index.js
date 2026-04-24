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
 */
async function pushIncomingCall(deviceIds, { callId, conversationId, kind, fromName }) {
  return pushToDevices(deviceIds, {
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
}

module.exports = { pushToDevices, pushIncomingCall };
