'use strict';

const { supabase } = require('../db/supabase');
const { readJson, badRequest, created, forbidden, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { broadcastToDevices } = require('../ws/dispatch');
const { pushToDevices } = require('../push');
const { check, send429 } = require('../middleware/rateLimit');

const VALID_KINDS = ['text', 'image', 'voice', 'video', 'file', 'location', 'poll'];

/**
 * POST /messages   (authed)
 *
 * The sender has already encrypted the plaintext once per recipient device.
 * We validate membership + recipient set, persist envelope + sealed copies,
 * and push to live WS connections of each recipient device.
 *
 * Body:
 * {
 *   conversation_id, kind,
 *   reply_to_message_id?, media_object_id?,
 *   recipients: [{ device_id, ciphertext: b64, nonce: b64 }, ...]
 * }
 */
async function sendMessage(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const lim = check([
    { key: `send:${req.auth.userId}`, max: 120, windowMs: 60_000 },
  ]);
  if (!lim.ok) return send429(res, lim);

  const {
    conversation_id: convId,
    kind,
    reply_to_message_id: replyTo = null,
    media_object_id: mediaId = null,
    forwarded = false,
    recipients,
  } = body;

  if (!convId || typeof convId !== 'string') return badRequest(res, 'conversation_id required');
  if (!VALID_KINDS.includes(kind)) return badRequest(res, 'Invalid kind');
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return badRequest(res, 'recipients[] required');
  }
  if (recipients.length > 500) return badRequest(res, 'Too many recipients');

  // Sender must be an active member
  const { data: me } = await supabase
    .from('conversation_members')
    .select('role')
    .eq('conversation_id', convId)
    .eq('user_id', req.auth.userId)
    .is('left_at', null)
    .maybeSingle();
  if (!me) return forbidden(res, 'Not a conversation member');

  // Respect only_admins_send
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, only_admins_send, deleted_at, workspace_id')
    .eq('id', convId).maybeSingle();
  if (!conv || conv.deleted_at) return forbidden(res, 'Conversation not found');
  if (conv.only_admins_send && !['owner', 'admin'].includes(me.role)) {
    return forbidden(res, 'Only admins may post here');
  }

  // Pull all valid recipient devices (active members × non-revoked devices)
  const { data: validDevices } = await supabase
    .from('devices')
    .select('id, user_id, revoked_at, conversation_members!inner(conversation_id, left_at)')
    .eq('conversation_members.conversation_id', convId)
    .is('revoked_at', null)
    .is('conversation_members.left_at', null);

  // Supabase's inner join syntax above can be quirky; fall back to two queries.
  // Simpler, explicit version:
  const { data: members } = await supabase
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', convId)
    .is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id);
  if (memberIds.length === 0) return forbidden(res, 'No active members');

  const { data: devices } = await supabase
    .from('devices')
    .select('id, user_id')
    .in('user_id', memberIds)
    .is('revoked_at', null);

  // Filter out devices of peers who have blocked the sender. We still let
  // the message go through to non-blocked members — blocking is per-pair,
  // not a full-chat kill. Sender's own devices stay (self-sync).
  const { data: blocks } = await supabase.from('user_blocks')
    .select('blocker_user_id')
    .in('blocker_user_id', memberIds.filter((u) => u !== req.auth.userId))
    .eq('blocked_user_id', req.auth.userId);
  const blockedBy = new Set((blocks || []).map((b) => b.blocker_user_id));
  const effectiveDevices = (devices || []).filter((d) => !blockedBy.has(d.user_id));
  const allowedDeviceIds = new Set(effectiveDevices.map((d) => d.id));
  const ownerByDevice = new Map(effectiveDevices.map((d) => [d.id, d.user_id]));

  // Validate: every provided recipient must be an allowed device; no duplicates
  const seen = new Set();
  for (const r of recipients) {
    if (!r?.device_id || !r?.ciphertext || !r?.nonce) {
      return badRequest(res, 'recipient must have device_id, ciphertext, nonce');
    }
    if (!allowedDeviceIds.has(r.device_id)) {
      return forbidden(res, `Device ${r.device_id} is not a valid recipient`);
    }
    if (seen.has(r.device_id)) return badRequest(res, 'Duplicate recipient device');
    seen.add(r.device_id);
  }

  // Must cover the sender's other devices too (for self-sync), but we don't
  // enforce "every member device". Senders can trim (e.g. for per-device
  // encryption errors). However: if any member has zero recipient devices
  // we refuse so that the message isn't silently delivered to nobody.
  const coveredUsers = new Set();
  {
    const map = new Map((devices || []).map((d) => [d.id, d]));
    for (const r of recipients) {
      const d = map.get(r.device_id);
      if (d) {
        const u = (devices || []).find((x) => x.id === r.device_id);
        if (u) {
          // We already filtered by user_id; need to re-query to map device→user.
        }
      }
    }
  }
  // Cheaper: query user_ids present in recipient set
  {
    const ids = Array.from(seen);
    const { data: rcpDevices } = await supabase
      .from('devices').select('id, user_id').in('id', ids);
    for (const d of rcpDevices || []) coveredUsers.add(d.user_id);
  }
  for (const u of memberIds) {
    if (!coveredUsers.has(u)) {
      return badRequest(res, `No recipient device for member ${u}`);
    }
  }

  // Insert envelope
  const { data: msg, error: msgErr } = await supabase.from('messages').insert({
    conversation_id: convId,
    sender_user_id: req.auth.userId,
    sender_device_id: req.auth.deviceId,
    kind,
    reply_to_message_id: replyTo,
    media_object_id: mediaId,
    forwarded_at: forwarded ? new Date().toISOString() : null,
  }).select('*').single();
  if (msgErr) return serverError(res, 'Could not create message', msgErr);

  // Insert sealed copies (stored as base64 strings)
  const rows = recipients.map((r) => ({
    message_id: msg.id,
    recipient_device_id: r.device_id,
    ciphertext: r.ciphertext,
    nonce: r.nonce,
  }));
  const { error: mrErr } = await supabase.from('message_recipients').insert(rows);
  if (mrErr) {
    // Roll back envelope on failure
    await supabase.from('messages').delete().eq('id', msg.id);
    return serverError(res, 'Could not persist recipients', mrErr);
  }

  // Poll spec: server assigns option IDs so votes can be tallied by ID
  // without the server ever seeing the option text. The client seals
  // {question, options: [{id, text}]} inside the message ciphertext and
  // only sends us the plaintext meta (count, flags).
  let pollOptions = null;
  if (kind === 'poll' && body.poll) {
    const p = body.poll;
    const optionCount = Math.max(2, Math.min(20, Number(p.option_count) || 0));
    if (!optionCount) {
      await supabase.from('messages').delete().eq('id', msg.id);
      return badRequest(res, 'poll.option_count required (2..20)');
    }
    const { data: poll, error: pErr } = await supabase.from('polls').insert({
      message_id: msg.id,
      conversation_id: convId,
      creator_user_id: req.auth.userId,
      multi_choice: !!p.multi_choice,
      anonymous: !!p.anonymous,
      closes_at: p.closes_at ? new Date(p.closes_at).toISOString() : null,
    }).select('*').single();
    if (pErr) {
      await supabase.from('messages').delete().eq('id', msg.id);
      return serverError(res, 'Could not create poll', pErr);
    }
    const optRows = Array.from({ length: optionCount }, (_, i) => ({
      poll_id: poll.id, position: i,
    }));
    const { data: optInserted, error: oErr } = await supabase.from('poll_options')
      .insert(optRows).select('id, position').order('position');
    if (oErr) {
      await supabase.from('polls').delete().eq('id', poll.id);
      await supabase.from('messages').delete().eq('id', msg.id);
      return serverError(res, 'Could not create poll options', oErr);
    }
    pollOptions = { poll, options: optInserted };
  }

  // Fire WS push (async) + push notifications to offline devices
  const recipientDeviceIds = recipients.map((r) => r.device_id);
  broadcastToDevices(
    recipientDeviceIds,
    (deviceId) => {
      const r = recipients.find((x) => x.device_id === deviceId);
      return {
        type: 'message.new',
        message: envelopeFor(msg),
        ciphertext: r.ciphertext,
        nonce: r.nonce,
      };
    },
  );

  // Push to offline devices — BUT skip the sender's own devices. A user
  // should never get a notification for a message they themselves sent
  // (even on a second device — self-sync happens silently via WS).
  const pushTargets = recipientDeviceIds.filter(
    (id) => ownerByDevice.get(id) !== req.auth.userId,
  );
  if (pushTargets.length > 0) {
    // Resolve sender + conversation titles for a nicer banner:
    //   Direct:   title = "Marlene",              body = "Neue Nachricht"
    //   Group:    title = "Team · Marlene",       body = "Neue Nachricht"
    const [{ data: sender }, { data: conv }] = await Promise.all([
      supabase.from('users')
        .select('display_name, username').eq('id', req.auth.userId).maybeSingle(),
      supabase.from('conversations')
        .select('kind, title').eq('id', convId).maybeSingle(),
    ]);
    const senderName =
      sender?.display_name || (sender?.username ? '@' + sender.username : 'Koro');
    const title = conv?.kind === 'direct'
      ? senderName
      : `${conv?.title || 'Gruppe'} · ${senderName}`;

    pushToDevices(pushTargets, {
      title,
      body: previewLabelFor(msg.kind),
      data: { type: 'message', conversation_id: convId, message_id: msg.id },
    }).catch(() => {});
  }

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'message.create',
    targetType: 'message', targetId: msg.id,
    metadata: { conversation_id: convId, kind, recipient_count: recipients.length },
    req,
  });

  // Fire webhook event. We emit envelope metadata only — the ciphertext is
  // per-recipient and subscribers don't hold the decryption keys anyway.
  try {
    const { emit } = require('../webhooks/dispatcher');
    const workspaceId = conv.workspace_id || null;
    emit({
      event: 'message.new',
      workspaceId,
      payload: {
        message: envelopeFor(msg),
        recipient_count: recipients.length,
      },
    });
  } catch (err) {
    // Swallow — webhook failures never break message send.
    console.warn('[webhook emit]', err?.message);
  }

  const envelope = envelopeFor(msg);
  if (pollOptions) {
    envelope.poll = {
      id: pollOptions.poll.id,
      multi_choice: pollOptions.poll.multi_choice,
      anonymous: pollOptions.poll.anonymous,
      closes_at: pollOptions.poll.closes_at,
      options: pollOptions.options, // [{ id, position }]
    };
  }
  created(res, { message: envelope });
}

function previewLabelFor(kind) {
  switch (kind) {
    case 'image': return '📷 Neues Bild';
    case 'voice': return '🎤 Neue Sprachnachricht';
    case 'video': return '🎞️ Neues Video';
    case 'file':  return '📎 Neue Datei';
    case 'poll':  return '📊 Neue Umfrage';
    default:      return 'Neue Nachricht';
  }
}

function envelopeFor(m) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    sender_user_id: m.sender_user_id,
    sender_device_id: m.sender_device_id,
    kind: m.kind,
    reply_to_message_id: m.reply_to_message_id,
    media_object_id: m.media_object_id,
    system_payload: m.system_payload ?? null,
    created_at: m.created_at,
    edited_at: m.edited_at,
    forwarded_at: m.forwarded_at ?? null,
    deleted_at: m.deleted_at,
  };
}

module.exports = { sendMessage, envelopeFor };
