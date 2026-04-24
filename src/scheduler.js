'use strict';

/**
 * Background sweeper for time-triggered features:
 *   1. Reminders whose `remind_at <= now()` and not yet fired
 *   2. Scheduled messages whose `send_at <= now()` and not yet sent
 *
 * Runs every 20 s. Ticks are idempotent: if a row has moved past the
 * deadline but we can't deliver (e.g. a recipient device was revoked),
 * we record the error on the row and skip until next tick.
 *
 * Single-process only — if we horizontally scale the API, move to a
 * proper queue (BullMQ on Redis) so jobs don't double-fire.
 */

const { supabase } = require('./db/supabase');
const { pushToDevices } = require('./push');
const { broadcastToDevices } = require('./ws/dispatch');
const { envelopeFor } = require('./messages/send');

const TICK_MS = 20_000;

let ticking = false;
let interval = null;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await Promise.all([fireReminders(), fireScheduledMessages()]);
  } catch (err) {
    console.error('[scheduler] tick failed', err?.message || err);
  } finally {
    ticking = false;
  }
}

async function fireReminders() {
  const now = new Date().toISOString();
  const { data: due } = await supabase
    .from('reminders')
    .select('id, user_id, title, body, task_id, conversation_id, message_id')
    .is('fired_at', null).is('dismissed_at', null)
    .lte('remind_at', now)
    .limit(50);
  if (!due?.length) return;

  for (const r of due) {
    try {
      // Mark fired FIRST to prevent double-firing if push fails/retries.
      await supabase.from('reminders').update({
        fired_at: new Date().toISOString(),
      }).eq('id', r.id);

      // Send a push to every one of that user's live devices.
      const { data: devs } = await supabase.from('devices').select('id')
        .eq('user_id', r.user_id).is('revoked_at', null);
      const deviceIds = (devs || []).map((d) => d.id);
      if (deviceIds.length === 0) continue;

      await pushToDevices(deviceIds, {
        title: r.title,
        body: r.body || 'Erinnerung',
        category: 'reminder',
        data: {
          type: 'reminder',
          reminder_id: r.id,
          task_id: r.task_id,
          conversation_id: r.conversation_id,
          message_id: r.message_id,
        },
        includeOnline: true, // reminders should buzz even while the app is foreground
      });
    } catch (err) {
      console.error('[scheduler:reminder]', r.id, err?.message || err);
    }
  }
}

async function fireScheduledMessages() {
  const now = new Date().toISOString();
  const { data: due } = await supabase
    .from('scheduled_messages')
    .select('*')
    .is('sent_at', null).is('canceled_at', null)
    .lte('send_at', now)
    .limit(20);
  if (!due?.length) return;

  for (const row of due) {
    try {
      await deliverScheduled(row);
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 500);
      console.error('[scheduler:scheduledMsg]', row.id, msg);
      await supabase.from('scheduled_messages').update({
        last_error: msg,
      }).eq('id', row.id);
    }
  }
}

async function deliverScheduled(row) {
  // Verify the sender is still a member — if they left the conv between
  // schedule and send time, abort.
  const { data: membership } = await supabase
    .from('conversation_members').select('user_id')
    .eq('conversation_id', row.conversation_id)
    .eq('user_id', row.sender_user_id)
    .is('left_at', null).maybeSingle();
  if (!membership) {
    await supabase.from('scheduled_messages').update({
      canceled_at: new Date().toISOString(),
      last_error: 'sender left conversation',
    }).eq('id', row.id);
    return;
  }

  // Verify sender's device isn't revoked.
  const { data: device } = await supabase.from('devices').select('id, revoked_at')
    .eq('id', row.sender_device_id).maybeSingle();
  if (!device || device.revoked_at) {
    await supabase.from('scheduled_messages').update({
      canceled_at: new Date().toISOString(),
      last_error: 'sender device revoked',
    }).eq('id', row.id);
    return;
  }

  // Filter recipients against still-live devices in the conv. Any device
  // that vanished since schedule-time simply gets skipped (the ciphertext
  // was sealed to a key that's now revoked anyway).
  const { data: members } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', row.conversation_id).is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id);
  const { data: liveDevs } = await supabase.from('devices')
    .select('id').in('user_id', memberIds).is('revoked_at', null);
  const liveSet = new Set((liveDevs || []).map((d) => d.id));

  const recipients = (row.recipients || []).filter((r) => liveSet.has(r.device_id));
  if (recipients.length === 0) {
    await supabase.from('scheduled_messages').update({
      canceled_at: new Date().toISOString(),
      last_error: 'no live recipients at send time',
    }).eq('id', row.id);
    return;
  }

  // Insert the real envelope.
  const { data: msg, error: msgErr } = await supabase.from('messages').insert({
    conversation_id: row.conversation_id,
    sender_user_id: row.sender_user_id,
    sender_device_id: row.sender_device_id,
    kind: row.kind || 'text',
    reply_to_message_id: row.reply_to_message_id,
  }).select('*').single();
  if (msgErr) throw msgErr;

  const rows = recipients.map((r) => ({
    message_id: msg.id,
    recipient_device_id: r.device_id,
    ciphertext: r.ciphertext,
    nonce: r.nonce,
  }));
  const { error: recErr } = await supabase.from('message_recipients').insert(rows);
  if (recErr) {
    // Roll back the envelope so we can retry next tick
    await supabase.from('messages').delete().eq('id', msg.id);
    throw recErr;
  }

  // Mark the scheduled row as delivered.
  await supabase.from('scheduled_messages').update({
    sent_at: new Date().toISOString(),
    sent_message_id: msg.id,
  }).eq('id', row.id);

  // Fan out: WS to everyone, push to offline recipients (minus the sender's
  // own devices — same self-push skip as in /messages).
  const deviceIds = recipients.map((r) => r.device_id);
  broadcastToDevices(deviceIds, (deviceId) => {
    const r = recipients.find((x) => x.device_id === deviceId);
    return {
      type: 'message.new',
      message: envelopeFor(msg),
      ciphertext: r?.ciphertext || null,
      nonce: r?.nonce || null,
    };
  });

  // Push to peer devices only.
  const { data: ownerMap } = await supabase.from('devices')
    .select('id, user_id').in('id', deviceIds);
  const pushTargets = deviceIds.filter((id) => {
    const rec = (ownerMap || []).find((d) => d.id === id);
    return rec && rec.user_id !== row.sender_user_id;
  });
  if (pushTargets.length > 0) {
    const { data: caller } = await supabase.from('users')
      .select('display_name, username').eq('id', row.sender_user_id).maybeSingle();
    const { data: conv } = await supabase.from('conversations')
      .select('kind, title').eq('id', row.conversation_id).maybeSingle();
    const senderName = caller?.display_name || (caller?.username ? '@' + caller.username : 'Koro');
    const title = conv?.kind === 'direct'
      ? senderName
      : `${conv?.title || 'Gruppe'} · ${senderName}`;
    pushToDevices(pushTargets, {
      title,
      body: 'Neue Nachricht',
      data: { type: 'message', conversation_id: row.conversation_id, message_id: msg.id },
    }).catch(() => {});
  }
}

function start() {
  if (interval) return;
  console.log('[scheduler] starting with tick interval', TICK_MS, 'ms');
  // Fire once right away so server boot delivers anything that was due
  // during downtime, then every TICK_MS after.
  tick().catch(() => {});
  interval = setInterval(tick, TICK_MS);
  interval.unref?.();
}

function stop() {
  if (interval) { clearInterval(interval); interval = null; }
}

module.exports = { start, stop };
