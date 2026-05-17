'use strict';

/**
 * koro-meet — multi-participant meetings (Google Meet style).
 *
 * Endpoints:
 *   POST   /meetings                        (auth or guest) → create
 *   GET    /meetings                        (auth)           → list mine
 *   GET    /meetings/:roomId                (no auth)        → details + participants
 *   POST   /meetings/:roomId/join           (auth or guest)  → register a participation
 *   POST   /meetings/:roomId/leave          (no auth)        → mark participation closed
 *   PATCH  /meetings/:roomId                (host only)      → update title/lock/etc
 *   DELETE /meetings/:roomId                (host only)      → hard-end
 *   GET    /meetings/:roomId/messages       (no auth)        → recent chat
 *   POST   /meetings/:roomId/messages       (no auth)        → post chat
 *
 * Auth model:
 *   • Endpoints marked "no auth" still require either a valid Bearer
 *     token OR a valid `x-koro-meet-device` header (the per-tab UUID
 *     minted client-side). The device header lets guests participate
 *     without registering an account; we only use it to identify
 *     a row in `meeting_participants`, never to mint a real session.
 *
 * Signaling (offer/answer/ice/peer-joined/peer-left/media-state/chat)
 * happens via the existing koroWs — see ws/router.js.
 */

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');

// 10-char base32-friendly slug — ~10^15 space, collisions ignorable.
const ROOM_ALPHA = 'abcdefghijkmnopqrstuvwxyz23456789';
function newRoomId() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += ROOM_ALPHA[bytes[i] % ROOM_ALPHA.length];
  return `${out.slice(0, 3)}-${out.slice(3, 7)}-${out.slice(7)}`;
}

// Pull either the authed user OR a guest identifier from the request.
// `device_id` and `display_name` are required for both.
//
// Guest device IDs are stored with a `meet:` prefix so they match the
// handle the WebSocket server registers their socket under (see
// ws/server.js `meet.auth`). Without the prefix, forwardToMeeting and
// meet.signal route by the bare uuid and silently miss every guest —
// no offers, no answers, no chat, no broadcasts.
function actorFor(req, body) {
  const auth = req.auth || null;
  const deviceHeader = req.headers['x-koro-meet-device'];
  const rawDeviceId = body?.device_id || deviceHeader || (auth?.deviceId);
  const cleaned = rawDeviceId ? String(rawDeviceId).slice(0, 64) : null;
  // Authenticated users keep their bare Koro device UUID — that's what
  // their WS connection is registered under. Guests get the `meet:`
  // prefix unless the client already supplied one (idempotent).
  let deviceId = cleaned;
  if (cleaned && !auth?.userId && !cleaned.startsWith('meet:')) {
    deviceId = `meet:${cleaned}`;
  }
  const displayName = (body?.display_name || '').trim();
  return {
    userId: auth?.userId || null,
    deviceId,
    displayName: displayName.slice(0, 64) || null,
    guestName: !auth?.userId && displayName ? displayName.slice(0, 64) : null,
  };
}

// ── Endpoints ─────────────────────────────────────────────────────────

async function create(req, res) {
  const body = await readJson(req).catch(() => null) || {};
  const actor = actorFor(req, body);
  if (!actor.deviceId) return badRequest(res, 'device_id required');
  if (!actor.userId && !actor.guestName) return badRequest(res, 'display_name required for guests');

  const title = (body.title || '').trim();
  if (!title || title.length > 200) return badRequest(res, 'title required (≤200 chars)');

  const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : null;
  if (body.scheduled_at && Number.isNaN(scheduledAt?.getTime())) {
    return badRequest(res, 'scheduled_at invalid');
  }

  // Make sure a freshly minted slug isn't already in use (vanishingly
  // unlikely, but cheap to verify).
  let roomId = newRoomId();
  for (let i = 0; i < 5; i++) {
    const { data } = await supabase.from('meetings').select('id').eq('room_id', roomId).maybeSingle();
    if (!data) break;
    roomId = newRoomId();
  }

  const { data: meeting, error } = await supabase.from('meetings').insert({
    room_id: roomId,
    title,
    description: body.description ? String(body.description).slice(0, 2000) : null,
    host_user_id: actor.userId,
    host_name: actor.userId ? null : actor.guestName,
    workspace_id: body.workspace_id || null,
    scheduled_at: scheduledAt ? scheduledAt.toISOString() : null,
    max_participants: Math.max(2, Math.min(50, Number(body.max_participants) || 50)),
    allow_guests: body.allow_guests !== false,
  }).select('*').single();
  if (error) return serverError(res, 'Could not create meeting', error);

  if (actor.userId) {
    audit({ userId: actor.userId, deviceId: req.auth?.deviceId,
      action: 'meeting.create', targetType: 'meeting', targetId: meeting.id,
      metadata: { room_id: roomId }, req });
  }

  created(res, { meeting });
}

async function listMine(req, res) {
  if (!req.auth?.userId) return forbidden(res, 'auth required');
  // "Mine" = hosted OR participated. Pull both sets and union.
  const [hostedRes, joinedRes] = await Promise.all([
    supabase.from('meetings')
      .select('*').eq('host_user_id', req.auth.userId)
      .order('created_at', { ascending: false }).limit(100),
    supabase.from('meeting_participants')
      .select('meeting_id, joined_at, meetings:meetings!inner(*)')
      .eq('user_id', req.auth.userId).order('joined_at', { ascending: false }).limit(100),
  ]);

  const seen = new Set();
  const list = [];
  for (const m of hostedRes.data || []) { seen.add(m.id); list.push(m); }
  for (const row of joinedRes.data || []) {
    const m = Array.isArray(row.meetings) ? row.meetings[0] : row.meetings;
    if (m && !seen.has(m.id)) { seen.add(m.id); list.push(m); }
  }
  list.sort((a, b) => new Date(b.scheduled_at || b.created_at) - new Date(a.scheduled_at || a.created_at));

  ok(res, { meetings: list });
}

async function getOne(req, res, { params }) {
  const roomId = params.roomId;
  const { data: meeting } = await supabase.from('meetings')
    .select('*').eq('room_id', roomId).maybeSingle();
  if (!meeting) return notFound(res);

  const { data: participants } = await supabase.from('meeting_participants')
    .select('id, user_id, guest_name, device_id, display_name, avatar_url, is_host, joined_at, left_at, mic_on, camera_on, raised_hand_at')
    .eq('meeting_id', meeting.id)
    .order('joined_at', { ascending: true });

  ok(res, { meeting, participants: participants || [] });
}

async function join(req, res, { params }) {
  const body = await readJson(req).catch(() => null) || {};
  const actor = actorFor(req, body);
  if (!actor.deviceId) return badRequest(res, 'device_id required');
  if (!actor.displayName) return badRequest(res, 'display_name required');

  const { data: meeting } = await supabase.from('meetings')
    .select('*').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);
  if (meeting.locked) return forbidden(res, 'Meeting is locked');
  if (!actor.userId && !meeting.allow_guests) return forbidden(res, 'Guests not allowed');
  if (meeting.ended_at) return forbidden(res, 'Meeting has ended');

  // Active-participant cap.
  const { count } = await supabase.from('meeting_participants')
    .select('id', { count: 'exact', head: true })
    .eq('meeting_id', meeting.id).is('left_at', null);
  if ((count || 0) >= meeting.max_participants) {
    return forbidden(res, 'Meeting is full');
  }

  // Reuse any existing row for this device — covers refresh / quick re-join.
  const { data: existing } = await supabase.from('meeting_participants')
    .select('*').eq('meeting_id', meeting.id).eq('device_id', actor.deviceId).maybeSingle();

  let participant;
  if (existing) {
    const { data, error } = await supabase.from('meeting_participants').update({
      left_at: null,
      display_name: actor.displayName,
      avatar_url: body.avatar_url || existing.avatar_url || null,
      user_id: actor.userId || existing.user_id,
      guest_name: actor.userId ? null : actor.displayName,
    }).eq('id', existing.id).select('*').single();
    if (error) return serverError(res, 'Rejoin failed', error);
    participant = data;
  } else {
    const isFirst = (count || 0) === 0;
    const { data, error } = await supabase.from('meeting_participants').insert({
      meeting_id: meeting.id,
      user_id: actor.userId,
      guest_name: actor.userId ? null : actor.displayName,
      device_id: actor.deviceId,
      display_name: actor.displayName,
      avatar_url: body.avatar_url || null,
      // First-to-join with no host on file becomes host (handy for
      // ad-hoc guest meetings).
      is_host: meeting.host_user_id ? meeting.host_user_id === actor.userId : isFirst,
    }).select('*').single();
    if (error) return serverError(res, 'Join failed', error);
    participant = data;
  }

  // Boot the meeting lifecycle on first join.
  if (!meeting.started_at) {
    await supabase.from('meetings').update({ started_at: new Date().toISOString() })
      .eq('id', meeting.id);
  }

  ok(res, { meeting, participant });
}

async function leave(req, res, { params }) {
  const body = await readJson(req).catch(() => null) || {};
  const actor = actorFor(req, body);
  const deviceId = actor.deviceId;
  if (!deviceId) return badRequest(res, 'device_id required');

  const { data: meeting } = await supabase.from('meetings')
    .select('id, host_user_id').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);

  await supabase.from('meeting_participants').update({
    left_at: new Date().toISOString(),
  }).eq('meeting_id', meeting.id).eq('device_id', deviceId).is('left_at', null);

  // Tell remaining participants the roster changed so they refresh + drop
  // the leaver's tile immediately, without waiting for WS heartbeat or
  // RTC connectionState=closed (which can take 10+ s).
  try {
    const { sendTo } = require('../ws/dispatch');
    const { data: peers } = await supabase.from('meeting_participants')
      .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
    for (const p of peers || []) {
      if (p.device_id === deviceId) continue;
      sendTo(p.device_id, {
        type: 'meet.broadcast',
        meeting_id: params.roomId,
        subtype: 'roster.changed',
        from_device_id: deviceId,
        payload: null,
      });
    }
  } catch (err) { console.warn('[meet.leave]', err); }

  // If everyone left, mark the meeting ended (allows the dashboard to
  // surface duration). Schedule-clean meetings stay around until the
  // host explicitly deletes.
  const { count } = await supabase.from('meeting_participants')
    .select('id', { count: 'exact', head: true })
    .eq('meeting_id', meeting.id).is('left_at', null);
  if ((count || 0) === 0) {
    await supabase.from('meetings').update({ ended_at: new Date().toISOString() })
      .eq('id', meeting.id);
  }

  ok(res, { ok: true });
}

async function update(req, res, { params }) {
  if (!req.auth?.userId) return forbidden(res);
  const body = await readJson(req).catch(() => null) || {};

  const { data: meeting } = await supabase.from('meetings')
    .select('id, host_user_id').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);
  if (meeting.host_user_id !== req.auth.userId) return forbidden(res, 'Host only');

  const patch = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) patch.title = String(body.title).slice(0, 200);
  if (body.description !== undefined) patch.description = body.description ? String(body.description).slice(0, 2000) : null;
  if (body.locked !== undefined) patch.locked = !!body.locked;
  if (body.allow_guests !== undefined) patch.allow_guests = !!body.allow_guests;
  if (body.max_participants !== undefined) {
    patch.max_participants = Math.max(2, Math.min(50, Number(body.max_participants) || 50));
  }
  if (body.scheduled_at !== undefined) {
    if (body.scheduled_at === null) patch.scheduled_at = null;
    else {
      const d = new Date(body.scheduled_at);
      if (Number.isNaN(d.getTime())) return badRequest(res, 'scheduled_at invalid');
      patch.scheduled_at = d.toISOString();
    }
  }

  const { data, error } = await supabase.from('meetings').update(patch)
    .eq('id', meeting.id).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { meeting: data });
}

async function destroy(req, res, { params }) {
  if (!req.auth?.userId) return forbidden(res);
  const { data: meeting } = await supabase.from('meetings')
    .select('id, host_user_id').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);
  if (meeting.host_user_id !== req.auth.userId) return forbidden(res, 'Host only');
  await supabase.from('meetings').delete().eq('id', meeting.id);
  ok(res, { ok: true });
}

async function listMessages(req, res, { params }) {
  const { data: meeting } = await supabase.from('meetings')
    .select('id').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);
  const { data } = await supabase.from('meeting_messages')
    .select('id, display_name, body, created_at')
    .eq('meeting_id', meeting.id)
    .order('created_at', { ascending: true }).limit(500);
  ok(res, { messages: data || [] });
}

async function postMessage(req, res, { params }) {
  const body = await readJson(req).catch(() => null) || {};
  const actor = actorFor(req, body);
  if (!actor.deviceId || !actor.displayName) return badRequest(res, 'device_id + display_name required');
  const text = (body.body || '').toString().trim();
  if (!text || text.length > 2000) return badRequest(res, 'body required (≤2000 chars)');

  const { data: meeting } = await supabase.from('meetings')
    .select('id').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);

  // Resolve participant row (active or last-known) for attribution.
  const { data: participant } = await supabase.from('meeting_participants')
    .select('id').eq('meeting_id', meeting.id).eq('device_id', actor.deviceId)
    .order('joined_at', { ascending: false }).limit(1).maybeSingle();

  const { data: msg, error } = await supabase.from('meeting_messages').insert({
    meeting_id: meeting.id,
    participant_id: participant?.id || null,
    display_name: actor.displayName,
    body: text,
  }).select('*').single();
  if (error) return serverError(res, 'Send failed', error);

  // Fan out to every active participant via WS so other tabs see the
  // chat instantly without polling. Excluded sender renders optimistically.
  try {
    const { sendTo } = require('../ws/dispatch');
    const { data: peers } = await supabase.from('meeting_participants')
      .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
    for (const p of peers || []) {
      if (p.device_id === actor.deviceId) continue;
      sendTo(p.device_id, {
        type: 'meet.broadcast',
        meeting_id: params.roomId,
        subtype: 'chat',
        payload: { id: msg.id, display_name: msg.display_name, body: msg.body, created_at: msg.created_at },
      });
    }
  } catch (err) { console.warn('[meet.chat]', err); }

  ok(res, { message: msg });
}

module.exports = { create, listMine, getOne, join, leave, update, destroy, listMessages, postMessage };
