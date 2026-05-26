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
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { plan, ensureDir } = require('../media/fs');

// Max PDF size that a meeting host can pin. 25 MB is enough for a
// typical slide deck but small enough to keep the streaming write
// from blowing up RAM.
const PDF_MAX_BYTES = 25 * 1024 * 1024;

// 10-char base32-friendly slug — ~10^15 space, collisions ignorable.
const ROOM_ALPHA = 'abcdefghijkmnopqrstuvwxyz23456789';
function newRoomId() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += ROOM_ALPHA[bytes[i] % ROOM_ALPHA.length];
  return `${out.slice(0, 3)}-${out.slice(3, 7)}-${out.slice(7)}`;
}

// koro-meet is a single front-end served under two branded domains:
//   • Koro   → https://meet.koro.chat
//   • Nexoro → https://meet.nexoro.net
// The front-end picks its brand from window.location.hostname (see
// koro-meet src/app/layout.tsx). We mirror that here so the meeting link
// we hand back points at whichever brand the request came from.
//
// Override per-environment (e.g. staging) via MEET_BASE_URL_KORO /
// MEET_BASE_URL_NEXORO. MEET_BASE_URL is kept as a legacy fallback for
// the Koro base.
const MEET_BASE_KORO = (process.env.MEET_BASE_URL_KORO || process.env.MEET_BASE_URL || 'https://meet.koro.chat').replace(/\/+$/, '');
const MEET_BASE_NEXORO = (process.env.MEET_BASE_URL_NEXORO || 'https://meet.nexoro.net').replace(/\/+$/, '');

// Decide the meet front-end base for this request's brand. Rule (per
// product spec): a request whose origin is on koro.chat gets the Koro
// front-end; a request from ANY other domain gets the Nexoro front-end.
// When no origin can be determined at all (e.g. a server-to-server call
// with no Origin/Referer header) we fall back to the Koro base.
function meetBaseForReq(req) {
  const src = req.headers.origin || req.headers.referer || '';
  let host = '';
  try { host = src ? new URL(src).hostname : ''; } catch { /* malformed */ }
  if (!host) return MEET_BASE_KORO;
  return /(^|\.)koro\.chat$/i.test(host) ? MEET_BASE_KORO : MEET_BASE_NEXORO;
}

function meetingUrl(req, roomId) {
  return `${meetBaseForReq(req)}/m/${roomId}`;
}

// Resolve the scheduled start time from the request body. Accepts either:
//   • scheduled_at — a full ISO-8601 timestamp, e.g. "2026-06-01T15:00:00Z"
//     or "2026-06-01T15:00:00+02:00"; OR
//   • date + time  — "YYYY-MM-DD" + "HH:MM" (seconds optional), combined
//     with an explicit utc_offset ("+02:00"; default "Z" = UTC). Splitting
//     date/time is convenient for form-style callers, but the offset is
//     required to pin an unambiguous instant — without it we assume UTC.
// Returns { date: Date|null, error: string|null }. No schedule fields →
// { date: null } meaning an instant (start-now) meeting.
function resolveScheduledAt(body) {
  if (body.scheduled_at) {
    const d = new Date(body.scheduled_at);
    return Number.isNaN(d.getTime())
      ? { date: null, error: 'scheduled_at invalid (use ISO-8601, e.g. 2026-06-01T15:00:00Z)' }
      : { date: d, error: null };
  }
  if (body.date || body.time) {
    if (!body.date || !body.time) {
      return { date: null, error: 'date and time must be provided together (YYYY-MM-DD + HH:MM)' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) {
      return { date: null, error: 'date invalid (expected YYYY-MM-DD)' };
    }
    const rawTime = String(body.time);
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(rawTime)) {
      return { date: null, error: 'time invalid (expected HH:MM or HH:MM:SS)' };
    }
    const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
    const offset = body.utc_offset ? String(body.utc_offset) : 'Z';
    const d = new Date(`${body.date}T${time}${offset}`);
    return Number.isNaN(d.getTime())
      ? { date: null, error: 'date/time/utc_offset combination invalid' }
      : { date: d, error: null };
  }
  return { date: null, error: null }; // no schedule → instant meeting
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

  const title = (body.title || '').trim();
  if (!title || title.length > 200) return badRequest(res, 'title required (≤200 chars)');

  // Host display name. An explicit `host_name` wins; otherwise we fall back
  // to `display_name` (kept for backwards compatibility with the in-app
  // guest-create flow). Authenticated callers are identified by their
  // account via host_user_id, so host_name stays null for them.
  const hostName = (body.host_name || body.display_name || '').toString().trim().slice(0, 64);
  if (!actor.userId && !hostName) {
    return badRequest(res, 'host_name required when creating without a Koro account');
  }

  const { date: scheduledAt, error: schedErr } = resolveScheduledAt(body);
  if (schedErr) return badRequest(res, schedErr);

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
    host_name: actor.userId ? null : hostName,
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

  // The shareable join link is the whole point for API callers, so surface
  // it (plus the bare room_id) alongside the full meeting record. The link's
  // domain follows the brand of the requesting origin (Koro vs Nexoro).
  created(res, { meeting, room_id: roomId, url: meetingUrl(req, roomId) });
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
  // Banned device list (set by host via /participants/:id/kick). The
  // handle stored here matches whatever WS routing key was active when
  // the kick happened, so we test both prefixed + bare forms to catch
  // any prefix mismatches between historic data and the current actor.
  const banned = meeting.banned_devices || [];
  if (banned.length) {
    const bareForBan = actor.deviceId.startsWith('meet:') ? actor.deviceId.slice(5) : actor.deviceId;
    const prefForBan = actor.deviceId.startsWith('meet:') ? actor.deviceId : `meet:${actor.deviceId}`;
    if (banned.includes(bareForBan) || banned.includes(prefForBan)) {
      return forbidden(res, 'Du wurdest aus diesem Meeting entfernt.');
    }
  }
  // Pre-start gate: until the host explicitly starts the meeting (or the
  // scheduled time arrives), only the host themselves may enter. Other
  // users see the countdown screen and join when the timer hits zero.
  if (meeting.scheduled_at && !meeting.started_at) {
    const scheduledMs = new Date(meeting.scheduled_at).getTime();
    if (Date.now() < scheduledMs) {
      const isHost = actor.userId && actor.userId === meeting.host_user_id;
      if (!isHost) return forbidden(res, 'Meeting hat noch nicht begonnen.');
    }
  }

  // Active-participant cap.
  const { count } = await supabase.from('meeting_participants')
    .select('id', { count: 'exact', head: true })
    .eq('meeting_id', meeting.id).is('left_at', null);
  if ((count || 0) >= meeting.max_participants) {
    return forbidden(res, 'Meeting is full');
  }

  // Find any active row that semantically represents this actor — covers:
  //   (a) Plain rejoin (same device_id).
  //   (b) Pre-prefix-fix rows where the same device was stored as the
  //       bare uuid before we started prepending `meet:` for guests.
  //   (c) Koro user reconnecting from a new device (same user_id).
  // We reuse the most recent matching row and mark all the others as
  // left so the user never appears twice in the roster.
  const bareDeviceId = actor.deviceId.startsWith('meet:') ? actor.deviceId.slice(5) : actor.deviceId;
  const prefDeviceId = actor.deviceId.startsWith('meet:') ? actor.deviceId : `meet:${actor.deviceId}`;
  let orFilter = `device_id.eq.${bareDeviceId},device_id.eq.${prefDeviceId}`;
  if (actor.userId) orFilter += `,user_id.eq.${actor.userId}`;

  const { data: existingRows } = await supabase.from('meeting_participants')
    .select('*').eq('meeting_id', meeting.id).is('left_at', null).or(orFilter);

  let participant;
  if (existingRows && existingRows.length > 0) {
    // Prefer the row that already matches the current device_id exactly;
    // otherwise take the most recently joined one.
    const sorted = [...existingRows].sort((a, b) =>
      new Date(b.joined_at).getTime() - new Date(a.joined_at).getTime());
    const keep = sorted.find((r) => r.device_id === actor.deviceId) || sorted[0];
    const others = sorted.filter((r) => r.id !== keep.id);
    if (others.length) {
      await supabase.from('meeting_participants')
        .update({ left_at: new Date().toISOString() })
        .in('id', others.map((r) => r.id));
    }
    const { data, error } = await supabase.from('meeting_participants').update({
      left_at: null,
      device_id: actor.deviceId, // normalise to the current handle form
      display_name: actor.displayName,
      avatar_url: body.avatar_url || keep.avatar_url || null,
      user_id: actor.userId || keep.user_id,
      guest_name: actor.userId ? null : actor.displayName,
    }).eq('id', keep.id).select('*').single();
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

// ── Host actions ──────────────────────────────────────────────────────

/**
 * Common: load the meeting + assert the caller is its host.
 *
 * Two valid host-paths:
 *   1. Koro user whose user_id matches meetings.host_user_id.
 *   2. Guest host: meetings.host_user_id IS NULL and the request's
 *      device handle (x-koro-meet-device header, normalised the same
 *      way join() does) matches an active meeting_participants row
 *      with is_host=true. This lets guest-created meetings still have
 *      kick / PDF / start-now host actions without forcing a login.
 */
async function assertHost(req, res, roomId) {
  const { data: meeting } = await supabase.from('meetings')
    .select('*').eq('room_id', roomId).maybeSingle();
  if (!meeting) { notFound(res); return null; }

  // Koro user host path.
  if (req.auth?.userId && meeting.host_user_id === req.auth.userId) {
    return meeting;
  }

  // Guest host path — only when no Koro host is on file.
  if (!meeting.host_user_id) {
    const rawDeviceId = req.headers['x-koro-meet-device'];
    if (rawDeviceId) {
      const cleaned = String(rawDeviceId).slice(0, 64);
      const candidates = cleaned.startsWith('meet:')
        ? [cleaned, cleaned.slice(5)]
        : [cleaned, `meet:${cleaned}`];
      const { data: hostRow } = await supabase.from('meeting_participants')
        .select('id, is_host, device_id')
        .eq('meeting_id', meeting.id)
        .is('left_at', null)
        .in('device_id', candidates)
        .eq('is_host', true)
        .maybeSingle();
      if (hostRow) return meeting;
    }
  }

  forbidden(res, 'Host only');
  return null;
}

/**
 * POST /meetings/:roomId/start
 * Host can skip the scheduled countdown and open the room for everyone
 * right now. We set started_at + clear scheduled_at so the join gate
 * stops blocking guests, and broadcast `meet.started` so any clients
 * sitting on the countdown screen route into the lobby.
 */
async function startNow(req, res, { params }) {
  const meeting = await assertHost(req, res, params.roomId);
  if (!meeting) return;

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase.from('meetings').update({
    started_at: meeting.started_at || now,
    scheduled_at: null,
    updated_at: now,
  }).eq('id', meeting.id).select('*').single();
  if (error) return serverError(res, 'Start failed', error);

  // Best-effort fan-out. Anyone in the countdown will pick this up and
  // jump into the lobby.
  try {
    const { sendTo } = require('../ws/dispatch');
    const { data: peers } = await supabase.from('meeting_participants')
      .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
    for (const p of peers || []) {
      sendTo(p.device_id, {
        type: 'meet.broadcast',
        meeting_id: params.roomId,
        subtype: 'started',
        payload: { started_at: updated.started_at },
      });
    }
  } catch (err) { console.warn('[meet.start]', err); }

  ok(res, { meeting: updated });
}

/**
 * POST /meetings/:roomId/participants/:participantId/kick
 * Host removes a participant from the room and bans their device_id so
 * they can't rejoin. We fan a `meet.kicked` event to the kicked device
 * so its client can drop the connection + show a message, and a
 * `roster.changed` to everyone else so their UIs update.
 */
async function kickParticipant(req, res, { params }) {
  const meeting = await assertHost(req, res, params.roomId);
  if (!meeting) return;

  const { data: participant } = await supabase.from('meeting_participants')
    .select('*').eq('id', params.participantId)
    .eq('meeting_id', meeting.id).maybeSingle();
  if (!participant) return notFound(res, 'Participant not found');
  if (participant.user_id && participant.user_id === meeting.host_user_id) {
    return badRequest(res, 'Host kann sich nicht selbst entfernen.');
  }

  const now = new Date().toISOString();
  await supabase.from('meeting_participants').update({ left_at: now })
    .eq('id', participant.id);

  const nextBanned = Array.from(new Set([...(meeting.banned_devices || []), participant.device_id]));
  await supabase.from('meetings').update({
    banned_devices: nextBanned,
    updated_at: now,
  }).eq('id', meeting.id);

  try {
    const { sendTo } = require('../ws/dispatch');
    // Tell the kicked device so its client routes out immediately.
    sendTo(participant.device_id, {
      type: 'meet.kicked',
      meeting_id: params.roomId,
      reason: 'kicked_by_host',
    });
    // Refresh everyone else's roster.
    const { data: peers } = await supabase.from('meeting_participants')
      .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
    for (const p of peers || []) {
      sendTo(p.device_id, {
        type: 'meet.broadcast',
        meeting_id: params.roomId,
        subtype: 'roster.changed',
        from_device_id: participant.device_id,
        payload: null,
      });
    }
  } catch (err) { console.warn('[meet.kick]', err); }

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'meeting.kick', targetType: 'meeting_participant', targetId: participant.id,
    metadata: { meeting_id: meeting.id, device_id: participant.device_id }, req,
  });

  ok(res, { ok: true });
}

/**
 * PATCH /meetings/:roomId/pdf
 * Body: { media_id: <uuid>, name: <string> }
 * Host pins a PDF that's already been uploaded via /media/upload. We
 * derive the canonical public URL from the media row + broadcast a
 * meet.broadcast subtype=pdf so live clients open the panel.
 *
 * DELETE /meetings/:roomId/pdf clears it.
 */
async function setPdf(req, res, { params }) {
  const meeting = await assertHost(req, res, params.roomId);
  if (!meeting) return;
  const body = await readJson(req).catch(() => null) || {};
  const mediaId = body.media_id;
  if (!mediaId) return badRequest(res, 'media_id required');

  const { data: media } = await supabase.from('media_objects')
    .select('id, mime_type, size_bytes').eq('id', mediaId).maybeSingle();
  if (!media) return notFound(res, 'Media not found');
  if (!/pdf/i.test(media.mime_type || '')) {
    return badRequest(res, 'Nur PDFs werden unterstützt.');
  }

  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}/media/${media.id}`;

  const pdf = {
    media_id: media.id,
    url,
    name: String(body.name || 'document.pdf').slice(0, 200),
    size_bytes: media.size_bytes,
    uploaded_at: new Date().toISOString(),
    uploaded_by: req.auth.userId,
  };

  const { data: updated, error } = await supabase.from('meetings').update({
    pdf, updated_at: new Date().toISOString(),
  }).eq('id', meeting.id).select('*').single();
  if (error) return serverError(res, 'PDF set failed', error);

  // Fan out so live clients open the panel.
  try {
    const { sendTo } = require('../ws/dispatch');
    const { data: peers } = await supabase.from('meeting_participants')
      .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
    for (const p of peers || []) {
      sendTo(p.device_id, {
        type: 'meet.broadcast',
        meeting_id: params.roomId,
        subtype: 'pdf',
        payload: { pdf },
      });
    }
  } catch (err) { console.warn('[meet.pdf]', err); }

  ok(res, { meeting: updated });
}

async function clearPdf(req, res, { params }) {
  const meeting = await assertHost(req, res, params.roomId);
  if (!meeting) return;
  const { data: updated, error } = await supabase.from('meetings').update({
    pdf: null, updated_at: new Date().toISOString(),
  }).eq('id', meeting.id).select('*').single();
  if (error) return serverError(res, 'PDF clear failed', error);
  try {
    const { sendTo } = require('../ws/dispatch');
    const { data: peers } = await supabase.from('meeting_participants')
      .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
    for (const p of peers || []) {
      sendTo(p.device_id, {
        type: 'meet.broadcast',
        meeting_id: params.roomId,
        subtype: 'pdf',
        payload: { pdf: null },
      });
    }
  } catch (err) { console.warn('[meet.pdf]', err); }
  ok(res, { meeting: updated });
}

/**
 * POST /meetings/:roomId/pdf-upload
 * Host-only PDF upload that works for both koro hosts AND guest hosts.
 * Reuses the standard media storage pipeline but accepts a NULL
 * uploader_user_id when the caller is a guest. Returns the resulting
 * meeting record so the client can patch its UI in one round trip.
 */
async function uploadPdf(req, res, { params }) {
  const meeting = await assertHost(req, res, params.roomId);
  if (!meeting) return;

  const mime = (req.headers['content-type'] || '').split(';')[0].trim();
  const size = Number(req.headers['content-length'] || 0);
  const fileName = (req.headers['x-file-name'] || 'document.pdf').toString().slice(0, 200);

  if (!/pdf/i.test(mime)) return badRequest(res, 'Nur PDFs werden unterstützt.');
  if (!size || size <= 0) return badRequest(res, 'Content-Length required');
  if (size > PDF_MAX_BYTES) {
    return badRequest(res, `PDF ist zu groß (max ${Math.round(PDF_MAX_BYTES / 1024 / 1024)} MB).`);
  }

  const p = plan(mime, fileName);
  await ensureDir(p.dir);

  const hash = crypto.createHash('sha256');
  let written = 0;
  const writeStream = fs.createWriteStream(p.absPath);
  req.on('data', (chunk) => hash.update(chunk));
  try {
    await pipeline(
      async function* (source) {
        for await (const chunk of source) {
          written += chunk.length;
          if (written > PDF_MAX_BYTES) {
            throw Object.assign(new Error('Body exceeds size limit'), { statusCode: 413 });
          }
          yield chunk;
        }
      }(req),
      writeStream,
    );
  } catch (err) {
    await fsp.unlink(p.absPath).catch(() => {});
    return serverError(res, 'Upload failed', err);
  }
  const sha256 = hash.digest('hex');

  // Only stamp a real device on the row when the caller authenticated
  // through the koro session pipeline (req.auth set by the Bearer JWT).
  // The koro-meet `x-koro-meet-device` header is a per-browser UUID that
  // does NOT exist in the `devices` table — using it here would trip
  // the foreign-key constraint. Leave it NULL for guest-host uploads.
  const { data: media, error: insErr } = await supabase.from('media_objects').insert({
    uploader_user_id: req.auth?.userId || null,
    uploader_device_id: req.auth?.deviceId || null,
    conversation_id: null,
    storage_key: p.storageKey,
    mime_type: mime,
    size_bytes: written,
    sha256,
  }).select('*').single();
  if (insErr) {
    await fsp.unlink(p.absPath).catch(() => {});
    return serverError(res, 'Could not register media', insErr);
  }

  // Pin to the meeting + fan out so live clients open the panel.
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}/media/${media.id}`;

  const pdf = {
    media_id: media.id,
    url,
    name: fileName,
    size_bytes: written,
    uploaded_at: new Date().toISOString(),
    uploaded_by: req.auth?.userId || null,
  };

  const { data: updated, error: updErr } = await supabase.from('meetings').update({
    pdf, updated_at: new Date().toISOString(),
  }).eq('id', meeting.id).select('*').single();
  if (updErr) return serverError(res, 'PDF pin failed', updErr);

  try {
    const { sendTo } = require('../ws/dispatch');
    const { data: peers } = await supabase.from('meeting_participants')
      .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
    for (const p2 of peers || []) {
      sendTo(p2.device_id, {
        type: 'meet.broadcast',
        meeting_id: params.roomId,
        subtype: 'pdf',
        payload: { pdf },
      });
    }
  } catch (err) { console.warn('[meet.pdf.upload]', err); }

  ok(res, { meeting: updated, pdf });
}

module.exports = {
  create, listMine, getOne, join, leave, update, destroy,
  listMessages, postMessage,
  startNow, kickParticipant, setPdf, clearPdf, uploadPdf,
};
