'use strict';

const { supabase } = require('../db/supabase');
const { ok, created, badRequest, notFound, forbidden, readJson, serverError } = require('../util/response');
const { broadcastToDevices, deviceOnline } = require('../ws/dispatch');
const { pushIncomingCall } = require('../push');
const config = require('../config');

const RING_TIMEOUT_MS = 45 * 1000;

/**
 * GET /calls/ice-servers
 * Authed — returns the ICE server list for the caller's WebRTC
 * peer-connection. STUN is free, TURN uses short-lived credentials if
 * the server is configured with a static username/credential.
 */
async function iceServers(req, res) {
  const servers = config.ice.stunUrls.map((u) => ({ urls: u }));
  if (config.ice.turnUrls.length > 0) {
    servers.push({
      urls: config.ice.turnUrls,
      username: config.ice.turnUsername || undefined,
      credential: config.ice.turnCredential || undefined,
    });
  }
  ok(res, { ice_servers: servers });
}

/**
 * POST /calls    { conversation_id, kind: 'audio'|'video'|'screen' }
 */
async function start(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.conversation_id || !['audio', 'video', 'screen'].includes(body.kind)) {
    return badRequest(res, 'conversation_id, kind required');
  }
  const { data: me } = await supabase.from('conversation_members').select('user_id')
    .eq('conversation_id', body.conversation_id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me) return forbidden(res);

  // We need the conversation kind to decide huddle-vs-direct semantics
  // for the reachability gate further down.
  const { data: conv } = await supabase.from('conversations')
    .select('kind, workspace_id').eq('id', body.conversation_id).maybeSingle();
  const isHuddle = conv?.kind === 'group' || conv?.kind === 'channel';

  const { data: call, error } = await supabase.from('calls').insert({
    conversation_id: body.conversation_id,
    kind: body.kind,
    initiator_user_id: req.auth.userId,
    initiator_device_id: req.auth.deviceId,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  await supabase.from('call_participants').insert({
    call_id: call.id, user_id: req.auth.userId, device_id: req.auth.deviceId,
    joined_at: new Date().toISOString(),
  });

  // Ring other participants' active devices. We do BOTH:
  //   1. WebSocket broadcast (instant for devices that are online)
  //   2. Push notification (wakes the app on locked/backgrounded devices)
  const { data: members } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', body.conversation_id).is('left_at', null);
  const otherIds = (members || []).map((m) => m.user_id).filter((u) => u !== req.auth.userId);

  // Reachability check: are there any non-revoked peer devices at all?
  // Are any of them currently online via WS or have a push token? If
  // neither, the client shows "Nicht erreichbar" immediately and saves
  // the caller from waiting 45 s on a call that will never ring.
  //
  // For group/channel "huddles" we never short-circuit — the call stays
  // open as a meeting room that other members can join when they come
  // online (matches Slack huddle / Discord voice-channel UX). The
  // "Direkt abgebrochen"-bug in workspace calls was this gate firing
  // when the caller was the only member currently with an online device
  // or push token registered.
  let reachable = isHuddle;          // huddles always count as reachable
  let targetDeviceIds = [];

  if (otherIds.length) {
    const { data: devices } = await supabase.from('devices').select('id')
      .in('user_id', otherIds).is('revoked_at', null);
    targetDeviceIds = (devices || []).map((d) => d.id);

    const { data: tokens } = await supabase.from('push_tokens')
      .select('device_id').in('device_id', targetDeviceIds);
    const hasPush = (tokens?.length || 0) > 0;
    const anyOnline = targetDeviceIds.some((id) => deviceOnline(id));
    if (!isHuddle) reachable = anyOnline || hasPush;
  }

  // Ring everyone we can reach (huddle or 1:1). For huddles with zero
  // online peers this is a no-op — fine; they'll get the call from the
  // unread-list / chat header when they come online.
  if (reachable && targetDeviceIds.length) {
    broadcastToDevices(targetDeviceIds, () => ({
      type: 'call.incoming',
      call_id: call.id,
      conversation_id: call.conversation_id,
      kind: call.kind,
      from_user_id: req.auth.userId,
      from_device_id: req.auth.deviceId,
    }));

    const { data: caller } = await supabase.from('users')
      .select('display_name, username').eq('id', req.auth.userId).maybeSingle();
    const fromName = caller?.display_name || caller?.username || 'Unbekannt';

    pushIncomingCall(targetDeviceIds, {
      callId: call.id,
      conversationId: call.conversation_id,
      kind: call.kind,
      fromName,
    }).catch((err) => console.error('[calls] push failed', err?.message || err));
  }

  if (reachable) {
    // Auto-end timer applies to 1:1 calls (where "missed" means
    // something). For huddles we let them sit until the initiator
    // explicitly hangs up — same as a Zoom/Slack meeting room.
    if (!isHuddle) {
      setTimeout(() => autoEndIfUnanswered(call.id).catch(() => {}), RING_TIMEOUT_MS).unref();
    }
  } else {
    // 1:1 with no reachable peer devices → mark unreachable.
    supabase.from('calls').update({
      ended_at: new Date().toISOString(),
      end_reason: 'unreachable',
    }).eq('id', call.id).then(() => {}, () => {});
  }

  created(res, {
    call,
    reachable,
    ring_timeout_ms: RING_TIMEOUT_MS,
  });
}

/**
 * Server-side fallback: if 45 s pass without a join or explicit end,
 * mark the call missed and notify everyone. Idempotent — re-entering is
 * safe, we just check ended_at first.
 */
async function autoEndIfUnanswered(callId) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
  if (!call || call.ended_at) return;

  // Was anyone other than the initiator already in the call? Then don't
  // mark missed — someone picked up right before the timer fired.
  const { data: parts } = await supabase.from('call_participants')
    .select('user_id').eq('call_id', callId);
  const joined = (parts || []).filter((p) => p.user_id !== call.initiator_user_id);
  if (joined.length > 0) return;

  await supabase.from('calls').update({
    ended_at: new Date().toISOString(),
    end_reason: 'missed',
  }).eq('id', callId);

  // Notify all devices we previously rang + the caller's device
  const { data: members } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', call.conversation_id).is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id);
  if (!memberIds.length) return;
  const { data: devices } = await supabase.from('devices')
    .select('id').in('user_id', memberIds).is('revoked_at', null);
  broadcastToDevices((devices || []).map((d) => d.id), () => ({
    type: 'call.ended',
    call_id: callId,
    end_reason: 'missed',
  }));
}

/**
 * POST /calls/:id/join
 */
async function join(req, res, { params }) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', params.id).maybeSingle();
  if (!call) return notFound(res);
  const { data: me } = await supabase.from('conversation_members').select('user_id')
    .eq('conversation_id', call.conversation_id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me) return forbidden(res);

  await supabase.from('call_participants').upsert({
    call_id: params.id, user_id: req.auth.userId, device_id: req.auth.deviceId,
    joined_at: new Date().toISOString(),
  }, { onConflict: 'call_id,user_id,device_id' });

  ok(res, { call });
}

/**
 * POST /calls/:id/reject   — recipient declines before joining.
 * Ends the call with reason='rejected' and notifies participants.
 */
async function reject(req, res, { params }) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', params.id).maybeSingle();
  if (!call) return notFound(res);
  if (call.ended_at) return ok(res, { call });

  // Only callees can reject; initiator should use /end
  if (call.initiator_user_id === req.auth.userId) {
    return badRequest(res, 'Initiator cannot reject their own call — use /end');
  }

  // Verify caller is an actual conv member
  const { data: me } = await supabase.from('conversation_members').select('user_id')
    .eq('conversation_id', call.conversation_id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me) return forbidden(res);

  const { data: updated } = await supabase.from('calls').update({
    ended_at: new Date().toISOString(),
    end_reason: 'rejected',
  }).eq('id', params.id).select('*').single();

  const { data: initiatorDevs } = await supabase.from('devices').select('id')
    .eq('user_id', call.initiator_user_id).is('revoked_at', null);
  broadcastToDevices((initiatorDevs || []).map((d) => d.id), () => ({
    type: 'call.rejected',
    call_id: params.id,
    by_user_id: req.auth.userId,
  }));

  ok(res, { call: updated });
}

/**
 * GET /calls?conversation_id=&limit=
 */
async function list(req, res, { query }) {
  let q = supabase.from('calls').select(`
    id, conversation_id, kind, initiator_user_id, started_at, ended_at, end_reason, duration_seconds
  `).order('started_at', { ascending: false }).limit(Math.min(Number(query.limit) || 50, 200));

  if (query.conversation_id) {
    q = q.eq('conversation_id', query.conversation_id);
  } else {
    // All conversations I'm a member of
    const { data: memberships } = await supabase.from('conversation_members')
      .select('conversation_id').eq('user_id', req.auth.userId).is('left_at', null);
    const convIds = (memberships || []).map((m) => m.conversation_id);
    if (!convIds.length) return ok(res, { calls: [] });
    q = q.in('conversation_id', convIds);
  }

  const { data, error } = await q;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { calls: data || [] });
}

/**
 * POST /calls/:id/leave
 */
async function leave(req, res, { params }) {
  await supabase.from('call_participants').update({ left_at: new Date().toISOString() })
    .eq('call_id', params.id).eq('user_id', req.auth.userId).eq('device_id', req.auth.deviceId);
  ok(res, { ok: true });
}

/**
 * POST /calls/:id/end   { reason?: 'normal' | 'canceled' | 'failed' }
 */
async function end(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  const wanted = body?.reason;
  const reason = ['normal', 'canceled', 'failed'].includes(wanted) ? wanted : 'normal';

  const { data: call } = await supabase.from('calls').select('*').eq('id', params.id).maybeSingle();
  if (!call) return notFound(res);
  if (call.ended_at) return ok(res, { call });
  if (call.initiator_user_id !== req.auth.userId) return forbidden(res, 'Initiator only');

  // If the call never connected and is being ended by the caller, prefer
  // 'canceled' even if the client didn't specify it — this keeps history
  // accurate when someone rings and hangs up before anyone answered.
  const { data: joinedParts } = await supabase.from('call_participants')
    .select('user_id').eq('call_id', params.id);
  const peerJoined = (joinedParts || []).some((p) => p.user_id !== call.initiator_user_id);
  const effectiveReason = !peerJoined && reason === 'normal' ? 'canceled' : reason;

  const { data: updated } = await supabase.from('calls').update({
    ended_at: new Date().toISOString(), end_reason: effectiveReason,
  }).eq('id', params.id).select('*').single();

  // Notify every device that was ever rung, not just those that joined —
  // otherwise the callee's ringing screen never dismisses when the caller
  // cancels before pickup.
  const { data: members } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', call.conversation_id).is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id);
  const { data: devs } = await supabase.from('devices')
    .select('id').in('user_id', memberIds).is('revoked_at', null);
  broadcastToDevices((devs || []).map((d) => d.id), () => ({
    type: 'call.ended',
    call_id: params.id,
    end_reason: effectiveReason,
  }));

  try {
    const { data: conv } = await supabase.from('conversations')
      .select('workspace_id').eq('id', call.conversation_id).maybeSingle();
    require('../webhooks/dispatcher').emit({
      event: 'call.ended',
      workspaceId: conv?.workspace_id || null,
      payload: { call: updated },
    });
  } catch { /* swallow */ }

  ok(res, { call: updated });
}

/**
 * GET /calls/:id
 * Returns a single call I'm a participant or member of. Used by the
 * mobile client to hydrate the incoming-call screen on cold start
 * after a push tap, when the original `call.incoming` WS event has
 * already been consumed (or never delivered, since the device was
 * killed).
 */
async function get(req, res, { params }) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', params.id).maybeSingle();
  if (!call) return notFound(res);

  const { data: me } = await supabase.from('conversation_members').select('user_id')
    .eq('conversation_id', call.conversation_id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me) return forbidden(res);

  // Resolve the initiator's currently-active device for the WebRTC
  // signaling target. Falls back to most-recently-enrolled device if
  // multiple are active — same heuristic the start endpoint uses.
  const { data: initiatorDev } = await supabase.from('devices')
    .select('id').eq('user_id', call.initiator_user_id).is('revoked_at', null)
    .order('enrolled_at', { ascending: false }).limit(1).maybeSingle();

  ok(res, { call, initiator_device_id: initiatorDev?.id || null });
}

module.exports = { start, join, leave, end, reject, list, get, iceServers };
