'use strict';

/**
 * Action endpoints for the status dashboard — POST /status/action/:name.
 * Gated by the SAME Basic-auth password as the dashboard (checked in the
 * route handler before dispatch). Each action is intentionally small,
 * idempotent where possible, and records an event so the change is visible in
 * the dashboard's own event log.
 */

const { supabase } = require('../db/supabase');
const { disconnectDevice, broadcastToDevices, sendTo } = require('../ws/dispatch');

// Notify everyone in a conversation that a call ended (mirrors calls/index.js).
async function broadcastCallEnded(call, reason) {
  try {
    const { data: members } = await supabase.from('conversation_members')
      .select('user_id').eq('conversation_id', call.conversation_id).is('left_at', null);
    const ids = (members || []).map((m) => m.user_id);
    if (!ids.length) return;
    const { data: devices } = await supabase.from('devices')
      .select('id').in('user_id', ids).is('revoked_at', null);
    broadcastToDevices((devices || []).map((d) => d.id), () => ({
      type: 'call.ended', call_id: call.id, end_reason: reason,
    }));
  } catch { /* best-effort */ }
}

// Drop any live participants out of a meeting (mirrors meetings/index.js endMeeting).
async function broadcastMeetingEnded(meeting) {
  try {
    const { data: peers } = await supabase.from('meeting_participants')
      .select('device_id').eq('meeting_id', meeting.id).is('left_at', null);
    for (const p of peers || []) {
      sendTo(p.device_id, { type: 'meet.broadcast', meeting_id: meeting.room_id, subtype: 'ended', payload: { reason: 'admin_ended' } });
    }
  } catch { /* best-effort */ }
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const ACTIONS = {
  // Re-queue failed webhook deliveries (reset attempt so the worker retries).
  async 'webhooks.retry'(body) {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabase.from('webhook_deliveries')
      .update({ attempt: 0 })
      .is('delivered_at', null)
      .gte('attempt', 6)
      .gte('created_at', dayAgo)
      .select('id');
    if (error) throw new Error(error.message);
    return { requeued: (data || []).length };
  },

  // Revoke a single device (emergency). Disconnects its live socket too.
  async 'device.revoke'(body) {
    const id = String(body.deviceId || '').trim();
    if (!id) throw new Error('deviceId required');
    const { error } = await supabase.from('devices')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: 'status-dashboard' })
      .eq('id', id).is('revoked_at', null);
    if (error) throw new Error(error.message);
    try { disconnectDevice(id, 'revoked'); } catch { /* not connected here */ }
    return { revoked: id };
  },

  // Toggle a feature flag on/off (or set percent rollout).
  async 'flag.set'(body) {
    const key = String(body.key || '').trim();
    if (!key) throw new Error('key required');
    const rollout = ['off', 'on', 'percent', 'workspace'].includes(body.rollout) ? body.rollout : 'off';
    const row = {
      key,
      rollout,
      percent: body.percent ?? null,
      description: body.description ?? null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('feature_flags')
      .upsert(row, { onConflict: 'key' }).select('*').single();
    if (error) throw new Error(error.message);
    return { flag: data };
  },

  // Remove a feature flag entirely.
  async 'flag.delete'(body) {
    const key = String(body.key || '').trim();
    if (!key) throw new Error('key required');
    const { error } = await supabase.from('feature_flags').delete().eq('key', key);
    if (error) throw new Error(error.message);
    return { deleted: key };
  },

  // Force-end a single live call (e.g. one stuck open after a crash).
  async 'call.end'(body) {
    const id = String(body.id || '').trim();
    if (!id) throw new Error('id required');
    const { data: call } = await supabase.from('calls').select('*').eq('id', id).maybeSingle();
    if (!call) throw new Error('call not found');
    if (call.ended_at) return { ended: id, alreadyEnded: true };
    const now = new Date().toISOString();
    const started = call.started_at ? new Date(call.started_at).getTime() : null;
    const dur = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : null;
    const { error } = await supabase.from('calls')
      .update({ ended_at: now, end_reason: 'admin_ended', duration_seconds: call.duration_seconds ?? dur })
      .eq('id', id);
    if (error) throw new Error(error.message);
    await broadcastCallEnded(call, 'admin_ended');
    return { ended: id };
  },

  // Force-end a single live meeting and drop its participants.
  async 'meeting.end'(body) {
    const id = String(body.id || '').trim();
    if (!id) throw new Error('id required');
    const { data: meeting } = await supabase.from('meetings').select('*').eq('id', id).maybeSingle();
    if (!meeting) throw new Error('meeting not found');
    if (meeting.ended_at) return { ended: id, alreadyEnded: true };
    const now = new Date().toISOString();
    const { error } = await supabase.from('meetings')
      .update({ ended_at: now, updated_at: now }).eq('id', id);
    if (error) throw new Error(error.message);
    await broadcastMeetingEnded(meeting);
    return { ended: id };
  },

  // Bulk-end every call that has been "live" for more than the stuck threshold
  // (default 2 h). Cleans up calls whose ended_at never got written.
  async 'calls.end_stuck'(body) {
    const hours = Math.max(0.25, Math.min(48, Number(body.hours) || 2));
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { data: stuck } = await supabase.from('calls')
      .select('id, conversation_id, started_at, duration_seconds')
      .is('ended_at', null).not('started_at', 'is', null).lt('started_at', cutoff)
      .limit(500);
    const list = stuck || [];
    if (!list.length) return { ended: 0 };
    const now = new Date().toISOString();
    for (const c of list) {
      const dur = c.started_at ? Math.max(0, Math.round((Date.now() - new Date(c.started_at).getTime()) / 1000)) : null;
      await supabase.from('calls')
        .update({ ended_at: now, end_reason: 'admin_ended', duration_seconds: c.duration_seconds ?? dur })
        .eq('id', c.id);
      await broadcastCallEnded(c, 'admin_ended');
    }
    return { ended: list.length };
  },

  // Delete a finished call from history. Refuses to delete a live call —
  // end it first so the WS end-signal fires.
  async 'call.delete'(body) {
    const id = String(body.id || '').trim();
    if (!id) throw new Error('id required');
    const { data: call } = await supabase.from('calls').select('id, ended_at').eq('id', id).maybeSingle();
    if (!call) throw new Error('call not found');
    if (!call.ended_at) throw new Error('call is still live — beende ihn zuerst');
    await supabase.from('call_participants').delete().eq('call_id', id).then(() => {}, () => {});
    const { error } = await supabase.from('calls').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: id };
  },

  // Delete a finished meeting from history (with its participant rows).
  async 'meeting.delete'(body) {
    const id = String(body.id || '').trim();
    if (!id) throw new Error('id required');
    const { data: meeting } = await supabase.from('meetings').select('id, ended_at').eq('id', id).maybeSingle();
    if (!meeting) throw new Error('meeting not found');
    if (!meeting.ended_at) throw new Error('meeting is still live — beende es zuerst');
    await supabase.from('meeting_participants').delete().eq('meeting_id', id).then(() => {}, () => {});
    const { error } = await supabase.from('meetings').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: id };
  },

  // Clear the in-Redis boot/deploy/shutdown event log (cosmetic reset).
  async 'events.clear'() {
    try {
      const { getBusClient } = require('../ws/dispatch');
      const r = getBusClient && getBusClient();
      if (r) await r.del('koro:events');
    } catch { /* ignore */ }
    return { cleared: true };
  },
};

/**
 * Handle POST /status/action/:name. Auth is already verified by the caller.
 * `name` is the action key; the JSON body carries action-specific params.
 */
async function statusAction(req, res, name) {
  const fn = ACTIONS[name];
  if (!fn) return json(res, 404, { error: `unknown action: ${name}` });
  let body;
  try { body = await readBody(req); } catch { body = {}; }
  try {
    const result = await fn(body);
    return json(res, 200, { ok: true, action: name, ...result });
  } catch (e) {
    return json(res, 400, { ok: false, error: e.message });
  }
}

module.exports = { statusAction, ACTIONS };
