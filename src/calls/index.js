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

module.exports = { start, join, leave, end };
