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
const { plan, ensureDir, planRecording, appendChunk } = require('../media/fs');
const { buildIceServers } = require('../calls/ice');

// Per-speaker recording caps. A chunk is one MediaRecorder timeslice (~4s of
// Opus ≈ tens of KB), so 8 MB is a huge safety margin; the whole recording is
// capped so one runaway tab can't fill the disk.
const REC_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const REC_TOTAL_MAX_BYTES = 300 * 1024 * 1024;

// FULL host recording (video+audio of the whole meeting) — much larger. A chunk
// is a few seconds of VP8/Opus; the total cap is generous ("no time limit" in
// practice) but bounded so a runaway can't fill the disk. ~4 GB ≈ many hours.
const FULLREC_CHUNK_MAX_BYTES = 32 * 1024 * 1024;
const FULLREC_TOTAL_MAX_BYTES = 4 * 1024 * 1024 * 1024;

// Unlisted share slug for the analysis page. base58-ish, ~22 chars.
const SHARE_ALPHA = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newShareToken() {
  const bytes = crypto.randomBytes(22);
  let out = '';
  for (let i = 0; i < 22; i++) out += SHARE_ALPHA[bytes[i] % SHARE_ALPHA.length];
  return out;
}

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

/**
 * GET /meetings/:roomId/ice-servers   (NO auth — koro-meet guests included)
 *
 * Returns the ICE/TURN server list for a meeting participant. koro-meet
 * allows guests (no Bearer token), so the authed /calls/ice-servers is not
 * reachable for them — without TURN they can't connect over mobile/CGNAT.
 *
 * Bound to an EXISTING, non-ended meeting so the (cost-bearing) Cloudflare
 * TURN minting can't be abused by arbitrary callers. Same list shape as
 * /calls/ice-servers: { ice_servers: [...] }.
 */
async function iceServers(req, res, { params }) {
  const { data: meeting } = await supabase.from('meetings')
    .select('id, ended_at').eq('room_id', params.roomId).maybeSingle();
  if (!meeting || meeting.ended_at) return notFound(res, 'Meeting not found');
  ok(res, { ice_servers: await buildIceServers() });
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
    .select('id, host_user_id, ended_at').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);

  // Is the leaver the host? Either the Koro account that owns the meeting, or
  // the participant row flagged is_host (covers guest-hosted meetings).
  const { data: leaver } = await supabase.from('meeting_participants')
    .select('is_host').eq('meeting_id', meeting.id).eq('device_id', deviceId).is('left_at', null).maybeSingle();
  const leaverIsHost =
    (!!meeting.host_user_id && !!actor.userId && meeting.host_user_id === actor.userId) || !!leaver?.is_host;

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

  // Host left → end the meeting for everyone and tell remaining clients to
  // drop out. (Also covers the "host closes the room" expectation.)
  if (leaverIsHost && !meeting.ended_at) {
    await supabase.from('meetings').update({ ended_at: new Date().toISOString() }).eq('id', meeting.id);
    // Host closed the room (tab close / navigate away) → queue analysis too, so
    // the recording gets processed even without an explicit "end" click.
    try { await ensureAnalysisPending(meeting.id); }
    catch (err) { console.warn('[meet.leave.analysis]', err); }
    // Finalize a running full recording (safety net — see endMeeting).
    try { await finalizeFullRecordingIfPending(meeting.id); }
    catch (err) { console.warn('[meet.leave.fullrec]', err); }
    try {
      const { sendTo } = require('../ws/dispatch');
      const { data: rest } = await supabase.from('meeting_participants')
        .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
      for (const p of rest || []) {
        sendTo(p.device_id, {
          type: 'meet.broadcast', meeting_id: params.roomId, subtype: 'ended',
          from_device_id: deviceId, payload: { reason: 'host_left' },
        });
      }
    } catch (err) { console.warn('[meet.leave.hostEnd]', err); }
    return ok(res, { ok: true, ended: true });
  }

  // If everyone left, mark the meeting ended (allows the dashboard to
  // surface duration). Schedule-clean meetings stay around until the
  // host explicitly deletes.
  const { count } = await supabase.from('meeting_participants')
    .select('id', { count: 'exact', head: true })
    .eq('meeting_id', meeting.id).is('left_at', null);
  if ((count || 0) === 0) {
    await supabase.from('meetings').update({ ended_at: new Date().toISOString() })
      .eq('id', meeting.id);
    // Meeting emptied out (e.g. the host's row was already marked left, so the
    // host-left branch above didn't fire) → still queue the analysis so a
    // recording isn't left unprocessed.
    if (!meeting.ended_at) {
      try { await ensureAnalysisPending(meeting.id); }
      catch (err) { console.warn('[meet.leave.emptyAnalysis]', err); }
    }
  }

  ok(res, { ok: true });
}

/**
 * POST /meetings/:roomId/end  (host only) — end a meeting from the overview.
 * Sets ended_at and broadcasts `ended` so any live participants drop out.
 */
async function endMeeting(req, res, { params }) {
  const meeting = await assertHost(req, res, params.roomId);
  if (!meeting) return;
  const now = new Date().toISOString();
  await supabase.from('meetings').update({ ended_at: meeting.ended_at || now, updated_at: now }).eq('id', meeting.id);

  // Queue post-meeting analysis (transcription + AI summary). The dedicated
  // worker picks up the pending row; here we just create it and return the
  // share token so the client can jump straight to the analysis page.
  let shareToken = null;
  try { shareToken = await ensureAnalysisPending(meeting.id); }
  catch (err) { console.warn('[meet.end.analysis]', err); }

  // SAFETY NET: if a full recording was running, finalize whatever bytes made it
  // to disk — so it's never stuck on "recording" when the meeting ends (covers
  // both "host ended without stopping the recording" and a lost client finalize).
  try { await finalizeFullRecordingIfPending(meeting.id); }
  catch (err) { console.warn('[meet.end.fullrec]', err); }

  try {
    const { sendTo } = require('../ws/dispatch');
    const { data: peers } = await supabase.from('meeting_participants')
      .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
    for (const p of peers || []) {
      sendTo(p.device_id, { type: 'meet.broadcast', meeting_id: params.roomId, subtype: 'ended', payload: { reason: 'host_ended' } });
    }
  } catch (err) { console.warn('[meet.end]', err); }
  ok(res, { ok: true, share_token: shareToken });
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

// ── Recording / transcription / analysis ─────────────────────────────────

/** Read the full raw request body into a Buffer, capped at `max` bytes. */
function readRawBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('Chunk too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * POST /meetings/:roomId/recording-chunk   (auth or guest)
 *
 * Streams one MediaRecorder timeslice (raw audio bytes) from a participant to
 * the server, appended to that speaker's single recording file. Query params:
 *   ?first=1  → first chunk of the recording (creates the file + row)
 *   ?final=1  → last chunk (stamps ended_at so the worker knows it's complete)
 * Identity: `x-koro-meet-device` header (guest) or Bearer (Koro user), plus an
 * `x-meet-name` header for the display name. Body: raw audio/webm bytes.
 */
async function recordingChunk(req, res, { params, query }) {
  const { data: meeting } = await supabase.from('meetings')
    .select('id, ended_at').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);

  // Resolve the speaker's signaling id the same way join() does.
  const actor = actorFor(req, null);
  if (!actor.deviceId) return badRequest(res, 'device_id required');
  // Display name arrives URL-encoded (HTTP headers are latin1; names may be
  // UTF-8). Decode defensively.
  let displayName = 'Teilnehmer';
  const rawName = req.headers['x-meet-name'];
  if (rawName) {
    try { displayName = decodeURIComponent(String(rawName)); }
    catch { displayName = String(rawName); }
  } else if (actor.displayName) {
    displayName = actor.displayName;
  }
  displayName = displayName.slice(0, 64);

  const isFirst = query?.first === '1' || req.headers['x-rec-first'] === '1';
  const isFinal = query?.final === '1' || req.headers['x-rec-final'] === '1';

  const p = planRecording(meeting.id, actor.deviceId, 'webm');

  // Read the chunk (may be empty on a bare final marker).
  let buf;
  try {
    buf = await readRawBody(req, REC_CHUNK_MAX_BYTES);
  } catch (err) {
    return serverError(res, 'Chunk read failed', err);
  }

  // Enforce the per-recording size cap BEFORE writing. Check the last known
  // size from the row so a runaway/malicious client can't fill the disk. Once
  // capped we silently drop further audio (200 min of Opus is already ~300 MB).
  const { data: existingRec } = await supabase.from('meeting_recordings')
    .select('bytes').eq('meeting_id', meeting.id)
    .eq('participant_device_id', actor.deviceId).maybeSingle();
  const priorBytes = Number(existingRec?.bytes || 0);

  let total = priorBytes;
  if (buf.length > 0 && priorBytes < REC_TOTAL_MAX_BYTES) {
    try {
      total = await appendChunk(p.absPath, buf);
    } catch (err) {
      return serverError(res, 'Chunk write failed', err);
    }
  } else if (buf.length > 0) {
    console.warn(`[meet.rec] cap reached for ${p.storageKey} (${priorBytes} bytes) — dropping chunk`);
  }

  // Upsert the per-speaker recording row. On the first chunk we create it; on
  // every chunk we bump bytes; on final we stamp ended_at.
  const now = new Date().toISOString();
  const patch = {
    meeting_id: meeting.id,
    participant_device_id: actor.deviceId,
    participant_display_name: displayName,
    participant_user_id: actor.userId || null,
    storage_key: p.storageKey,
    mime_type: 'audio/webm',
    bytes: total || undefined,
  };
  if (isFinal) patch.ended_at = now;
  if (isFirst) patch.started_at = now;

  // Clean undefined so we don't overwrite bytes with null when total is 0.
  Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);

  const { error } = await supabase.from('meeting_recordings')
    .upsert(patch, { onConflict: 'meeting_id,participant_device_id' });
  if (error) return serverError(res, 'Recording row failed', error);

  ok(res, { ok: true, bytes: total });
}

/** Ensure a pending analysis row (+ share token) exists for a meeting. */
async function ensureAnalysisPending(meetingId) {
  const { data: existing } = await supabase.from('meeting_analysis')
    .select('meeting_id, status, share_token').eq('meeting_id', meetingId).maybeSingle();
  if (existing) {
    // Re-queue only if a prior run failed; leave done/processing alone.
    if (existing.status === 'failed') {
      await supabase.from('meeting_analysis')
        .update({ status: 'pending', error: null, updated_at: new Date().toISOString() })
        .eq('meeting_id', meetingId);
    }
    return existing.share_token;
  }
  const share_token = newShareToken();
  await supabase.from('meeting_analysis').insert({
    meeting_id: meetingId, status: 'pending', share_token,
  });
  return share_token;
}

/** Shape a full analysis payload (durations + summary + transcript timeline). */
async function buildAnalysisPayload(meeting, analysis, opts = {}) {
  const [{ data: participants }, { data: segments }, { data: notesRow }] = await Promise.all([
    supabase.from('meeting_participants')
      .select('display_name, device_id, user_id, is_host, joined_at, left_at')
      .eq('meeting_id', meeting.id).order('joined_at', { ascending: true }),
    supabase.from('meeting_transcripts')
      .select('speaker_display_name, speaker_device_id, text, started_offset_ms, ended_offset_ms')
      .eq('meeting_id', meeting.id).order('started_offset_ms', { ascending: true }),
    supabase.from('meeting_notes')
      .select('content').eq('meeting_id', meeting.id).maybeSingle(),
  ]);

  // Collapse reconnect rows into one duration per speaker.
  const byPerson = new Map();
  for (const p of participants || []) {
    const key = p.user_id || p.device_id;
    const joined = p.joined_at ? new Date(p.joined_at).getTime() : null;
    const left = p.left_at ? new Date(p.left_at).getTime()
      : (meeting.ended_at ? new Date(meeting.ended_at).getTime() : Date.now());
    const dur = joined != null ? Math.max(0, left - joined) : 0;
    const prev = byPerson.get(key);
    if (prev) {
      prev.total_ms += dur;
      if (p.is_host) prev.is_host = true;
    } else {
      byPerson.set(key, {
        display_name: p.display_name, is_host: !!p.is_host,
        joined_at: p.joined_at, total_ms: dur,
      });
    }
  }

  return {
    status: analysis.status,
    meeting: {
      title: meeting.title,
      started_at: meeting.started_at,
      ended_at: meeting.ended_at,
      duration_ms: meeting.started_at && meeting.ended_at
        ? new Date(meeting.ended_at).getTime() - new Date(meeting.started_at).getTime()
        : null,
    },
    participants: [...byPerson.values()].sort((a, b) => b.total_ms - a.total_ms),
    summary_md: analysis.summary_md || null,
    transcript: (segments || []).map((s) => ({
      speaker: s.speaker_display_name,
      text: s.text,
      offset_ms: Number(s.started_offset_ms) || 0,
    })),
    notes: (notesRow?.content || '').trim() || null,
    // PRIVATE: only present in the owner's own analysis, never in the shared view.
    copilot_suggestions: opts.copilotSuggestions || [],
    full_recording: analysis.full_recording_media_id
      ? { media_id: analysis.full_recording_media_id, status: analysis.full_recording_status || 'ready' }
      : (analysis.full_recording_status && analysis.full_recording_status !== 'none'
          ? { media_id: null, status: analysis.full_recording_status }
          : null),
    share_token: analysis.share_token,
  };
}

/**
 * GET /meetings/:roomId/analysis   (auth or guest participant)
 * Returns the analysis status and, once done, the full payload.
 */
async function getAnalysis(req, res, { params }) {
  const { data: meeting } = await supabase.from('meetings')
    .select('id, title, started_at, ended_at').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);

  const { data: analysis } = await supabase.from('meeting_analysis')
    .select('*').eq('meeting_id', meeting.id).maybeSingle();
  if (!analysis) return ok(res, { status: 'none' });

  // Private: attach the CALLER's own kept copilot suggestions (device-scoped).
  const actor = actorFor(req, {});
  const copilotSuggestions = await getOwnCopilotSuggestions(meeting.id, actor);
  ok(res, await buildAnalysisPayload(meeting, analysis, { copilotSuggestions }));
}

/**
 * GET /meetings/shared/:shareToken   (PUBLIC — no auth)
 * Read-only analysis for anyone with the unlisted link. Only served once the
 * analysis is done (a still-processing meeting returns just its status).
 */
async function getSharedAnalysis(req, res, { params }) {
  const token = String(params.shareToken || '').slice(0, 40);
  if (!token) return notFound(res);
  const { data: analysis } = await supabase.from('meeting_analysis')
    .select('*').eq('share_token', token).maybeSingle();
  if (!analysis) return notFound(res);

  const { data: meeting } = await supabase.from('meetings')
    .select('id, title, started_at, ended_at').eq('id', analysis.meeting_id).maybeSingle();
  if (!meeting) return notFound(res);

  if (analysis.status !== 'done') {
    return ok(res, { status: analysis.status });
  }
  ok(res, await buildAnalysisPayload(meeting, analysis));
}

/**
 * POST /meetings/:roomId/analysis/retry   (auth or guest participant)
 * Re-queue a failed analysis: reset it to pending and clear the attempt count so
 * the worker gives it a fresh set of tries. No-op if it isn't failed.
 */
async function retryAnalysis(req, res, { params }) {
  const { data: meeting } = await supabase.from('meetings')
    .select('id').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);

  const { data: analysis } = await supabase.from('meeting_analysis')
    .select('meeting_id, status').eq('meeting_id', meeting.id).maybeSingle();
  if (!analysis) return notFound(res);
  if (analysis.status !== 'failed') {
    return ok(res, { ok: true, status: analysis.status }); // nothing to retry
  }
  await supabase.from('meeting_analysis')
    .update({ status: 'pending', attempts: 0, error: null, updated_at: new Date().toISOString() })
    .eq('meeting_id', meeting.id);
  ok(res, { ok: true, status: 'pending' });
}

// ── Shared collaborative notes ────────────────────────────────────────────

/**
 * GET /meetings/:roomId/notes   (auth or guest participant)
 * Returns the current shared notes document. Late-joiners load this to sync.
 */
async function getNotes(req, res, { params }) {
  const { data: meeting } = await supabase.from('meetings')
    .select('id').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);
  const { data: row } = await supabase.from('meeting_notes')
    .select('content, updated_at').eq('meeting_id', meeting.id).maybeSingle();
  ok(res, { content: row?.content || '', updated_at: row?.updated_at || null });
}

/**
 * PUT /meetings/:roomId/notes   { content }   (auth or guest participant)
 * Persist the shared notes (last-write-wins). The client debounces this; live
 * typing sync happens over WS (meet.broadcast subtype:'notes'), this is just the
 * durable copy that feeds the analysis page.
 */
async function putNotes(req, res, { params }) {
  const body = await readJson(req).catch(() => null) || {};
  const actor = actorFor(req, body);
  const content = typeof body.content === 'string' ? body.content.slice(0, 100000) : '';

  const { data: meeting } = await supabase.from('meetings')
    .select('id').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);

  const { error } = await supabase.from('meeting_notes').upsert({
    meeting_id: meeting.id,
    content,
    updated_by: actor.displayName || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'meeting_id' });
  if (error) return serverError(res, 'Notes save failed', error);
  ok(res, { ok: true });
}

// ── Private "Koro Copilot" saved suggestions ──────────────────────────────

/**
 * POST /meetings/:roomId/copilot-suggestion   { kind, title, text }
 * The user kept a copilot suggestion (e.g. copied it). Persist it PRIVATELY,
 * scoped to their device, so it can show in THEIR analysis. Never shared.
 */
async function saveCopilotSuggestion(req, res, { params }) {
  const body = await readJson(req).catch(() => null) || {};
  const actor = actorFor(req, body);
  if (!actor.deviceId) return badRequest(res, 'device required');
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
  if (!text) return badRequest(res, 'text required');
  const kind = ['objection', 'suggestion', 'nudge', 'answer'].includes(body.kind) ? body.kind : 'suggestion';
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null;

  const { data: meeting } = await supabase.from('meetings')
    .select('id').eq('room_id', params.roomId).maybeSingle();
  if (!meeting) return notFound(res);

  const { error } = await supabase.from('meeting_copilot_suggestions').insert({
    meeting_id: meeting.id,
    owner_device_id: actor.deviceId,
    owner_user_id: actor.userId,
    kind, title, text,
  });
  if (error) return serverError(res, 'Copilot save failed', error);
  ok(res, { ok: true });
}

/** Fetch a caller's own saved copilot suggestions for a meeting (private). */
async function getOwnCopilotSuggestions(meetingId, actor) {
  if (!actor?.deviceId) return [];
  let q = supabase.from('meeting_copilot_suggestions')
    .select('kind, title, text, created_at')
    .eq('meeting_id', meetingId)
    .order('created_at', { ascending: true });
  // Match by device; also include the user's rows across their devices.
  if (actor.userId) {
    q = q.or(`owner_device_id.eq.${actor.deviceId},owner_user_id.eq.${actor.userId}`);
  } else {
    q = q.eq('owner_device_id', actor.deviceId);
  }
  const { data } = await q;
  return (data || []).map((r) => ({ kind: r.kind, title: r.title, text: r.text }));
}

// ── Full host recording (camera + screen + everyone's audio) ──────────────

/**
 * POST /meetings/:roomId/full-recording-chunk   (host only)
 * Streams one MediaRecorder timeslice of the host-mixed full recording (one
 * combined video), appended to uploads/meetings/<id>/full.webm. Query: ?first=1.
 * Deliberately SEPARATE from the per-speaker recording path so the big file
 * isn't subject to the per-speaker caps / retention / auto-delete.
 */
async function fullRecordingChunk(req, res, { params, query }) {
  const meeting = await assertHost(req, res, params.roomId);
  if (!meeting) return;

  const isFirst = query?.first === '1' || req.headers['x-rec-first'] === '1';
  const p = planRecording(meeting.id, 'full', 'webm');

  let buf;
  try { buf = await readRawBody(req, FULLREC_CHUNK_MAX_BYTES); }
  catch (err) { return serverError(res, 'Chunk read failed', err); }

  // Cap check against the file's current size.
  let curSize = 0;
  try { curSize = (await fsp.stat(p.absPath)).size; } catch { /* not created yet */ }
  if (curSize >= FULLREC_TOTAL_MAX_BYTES) {
    console.warn(`[meet.fullrec] cap reached for ${p.storageKey}`);
    return ok(res, { ok: true, capped: true });
  }

  if (buf.length > 0) {
    try { await appendChunk(p.absPath, buf); }
    catch (err) { return serverError(res, 'Chunk write failed', err); }
  }

  if (isFirst) {
    // Mark the analysis row as recording (create it if the meeting hasn't ended
    // yet — ensureAnalysisPending is safe to call and returns the share token).
    await ensureAnalysisPending(meeting.id).catch(() => {});
    await supabase.from('meeting_analysis')
      .update({ full_recording_status: 'recording', updated_at: new Date().toISOString() })
      .eq('meeting_id', meeting.id);
  }
  ok(res, { ok: true });
}

/**
 * Register whatever full.webm exists on disk as the meeting's full recording and
 * flip the analysis to 'ready'. Idempotent + safe to call from multiple paths
 * (the client's finalize call AND the server-side end/leave hooks) — this is the
 * SAFETY NET so a recording is never left stuck in 'recording' if the client
 * couldn't finalize (tab closed, network drop, meeting ended for everyone).
 *
 * Returns { media_id } on success, null if there's nothing to finalize. Only
 * acts when the current status is 'recording' or 'processing' (never clobbers an
 * already-ready recording, and doesn't invent one where none was started).
 */
/** Stream a file and return its sha256 hex digest (media_objects requires it). */
function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(absPath);
    s.on('data', (c) => hash.update(c));
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}

async function finalizeFullRecordingIfPending(meetingId) {
  const { data: row } = await supabase.from('meeting_analysis')
    .select('full_recording_status, full_recording_media_id').eq('meeting_id', meetingId).maybeSingle();
  if (!row) return null;
  if (row.full_recording_media_id) return { media_id: row.full_recording_media_id }; // already done
  if (row.full_recording_status !== 'recording' && row.full_recording_status !== 'processing') return null;

  const p = planRecording(meetingId, 'full', 'webm');
  let size = 0;
  try { size = (await fsp.stat(p.absPath)).size; } catch { size = 0; }
  if (size <= 0) {
    // Recording was started but no bytes landed — mark failed so the UI stops
    // showing "wird verarbeitet…".
    await supabase.from('meeting_analysis')
      .update({ full_recording_status: 'failed', updated_at: new Date().toISOString() })
      .eq('meeting_id', meetingId);
    return null;
  }

  // media_objects.sha256 is NOT NULL — hash the file before inserting.
  let sha256;
  try { sha256 = await sha256File(p.absPath); }
  catch (err) { console.warn('[fullrec.finalize] hash failed', err?.message || err); return null; }

  const { data: media, error } = await supabase.from('media_objects').insert({
    conversation_id: null,
    storage_key: p.storageKey,
    mime_type: 'video/webm',
    size_bytes: size,
    sha256,
  }).select('id').single();
  if (error) { console.warn('[fullrec.finalize] insert failed', error.message); return null; }

  await supabase.from('meeting_analysis')
    .update({
      full_recording_media_id: media.id,
      full_recording_status: 'ready',
      updated_at: new Date().toISOString(),
    })
    .eq('meeting_id', meetingId);
  return { media_id: media.id };
}

/**
 * POST /meetings/:roomId/full-recording-finalize   (host only)
 * Registers the finished full.webm as a public media_objects row and points the
 * analysis at it (status → ready). If no file exists, marks failed.
 */
async function fullRecordingFinalize(req, res, { params }) {
  const meeting = await assertHost(req, res, params.roomId);
  if (!meeting) return;

  await ensureAnalysisPending(meeting.id).catch(() => {});
  // Force status to 'processing' first so the shared helper acts even if the
  // client never set 'recording' (e.g. finalize arrives before the first chunk's
  // status write landed).
  await supabase.from('meeting_analysis')
    .update({ full_recording_status: 'processing', updated_at: new Date().toISOString() })
    .eq('meeting_id', meeting.id)
    .is('full_recording_media_id', null);

  const result = await finalizeFullRecordingIfPending(meeting.id);
  if (!result) return badRequest(res, 'No recording file');
  ok(res, { ok: true, media_id: result.media_id });
}

module.exports = {
  create, listMine, getOne, iceServers, join, leave, update, destroy,
  listMessages, postMessage,
  startNow, kickParticipant, setPdf, clearPdf, uploadPdf, endMeeting,
  recordingChunk, getAnalysis, getSharedAnalysis, ensureAnalysisPending,
  retryAnalysis, getNotes, putNotes, fullRecordingChunk, fullRecordingFinalize,
  saveCopilotSuggestion,
};
