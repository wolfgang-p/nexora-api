'use strict';

const { supabase } = require('../db/supabase');
const { ok, created, badRequest, notFound, forbidden, readJson, serverError } = require('../util/response');
const { broadcastToDevices } = require('../ws/dispatch');

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

  // Ring other participants' active devices
  const { data: members } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', body.conversation_id).is('left_at', null);
  const otherIds = (members || []).map((m) => m.user_id).filter((u) => u !== req.auth.userId);
  if (otherIds.length) {
    const { data: devices } = await supabase.from('devices').select('id')
      .in('user_id', otherIds).is('revoked_at', null);
    broadcastToDevices((devices || []).map((d) => d.id), () => ({
      type: 'call.incoming',
      call_id: call.id,
      conversation_id: call.conversation_id,
      kind: call.kind,
      from_user_id: req.auth.userId,
      from_device_id: req.auth.deviceId,
    }));
  }

  created(res, { call });
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
 * POST /calls/:id/end
 */
async function end(req, res, { params }) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', params.id).maybeSingle();
  if (!call) return notFound(res);
  if (call.ended_at) return ok(res, { call });
  if (call.initiator_user_id !== req.auth.userId) return forbidden(res, 'Initiator only');

  const { data: updated } = await supabase.from('calls').update({
    ended_at: new Date().toISOString(), end_reason: 'normal',
  }).eq('id', params.id).select('*').single();

  // Notify participants
  const { data: parts } = await supabase.from('call_participants')
    .select('device_id').eq('call_id', params.id);
  broadcastToDevices((parts || []).map((p) => p.device_id), () => ({
    type: 'call.ended', call_id: params.id,
  }));
  ok(res, { call: updated });
}

module.exports = { start, join, leave, end, reject, list };
