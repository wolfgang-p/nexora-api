'use strict';

const { Expo } = require('expo-server-sdk');
const { supabase } = require('../db/supabase');
const { deviceOnline } = require('../ws/dispatch');
const config = require('../config');

const expo = new Expo({ accessToken: config.push.expoAccessToken || undefined });

/**
 * Push to devices that aren't currently online via WebSocket. Never includes
 * plaintext — only envelope metadata so third-party infra never sees content.
 */
async function pushToDevices(deviceIds, { title, body, data }) {
  if (!deviceIds?.length) return;
  const offline = deviceIds.filter((id) => !deviceOnline(id));
  if (!offline.length) return;

  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('device_id, token, platform')
    .in('device_id', offline);
  if (!tokens?.length) return;

  const messages = [];
  for (const t of tokens) {
    if (!Expo.isExpoPushToken(t.token)) continue;
    messages.push({
      to: t.token,
      sound: 'default',
      title,
      body,
      data: data || {},
      priority: 'high',
      channelId: 'messages',
    });
  }
  if (!messages.length) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i];
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
          await supabase.from('push_tokens').delete().eq('token', chunk[i].to);
        }
      }
    } catch (err) {
      console.error('[push]', err?.message || err);
    }
  }
}

module.exports = { pushToDevices };
