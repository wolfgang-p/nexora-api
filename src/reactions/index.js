'use strict';

const { supabase } = require('../db/supabase');
const { ok, badRequest, forbidden, readJson, serverError } = require('../util/response');
const { broadcastToDevices } = require('../ws/dispatch');

async function add(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.emoji) return badRequest(res, 'emoji required');

  const { data: msg } = await supabase.from('messages').select('conversation_id')
    .eq('id', params.id).maybeSingle();
  if (!msg) return badRequest(res, 'Message not found');
  const { data: me } = await supabase.from('conversation_members').select('user_id')
    .eq('conversation_id', msg.conversation_id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me) return forbidden(res);

  const { error } = await supabase.from('message_reactions').upsert({
    message_id: params.id, user_id: req.auth.userId, emoji: body.emoji,
  }, { onConflict: 'message_id,user_id,emoji' });
  if (error) return serverError(res, 'Insert failed', error);

  await broadcastReaction(msg.conversation_id, params.id, 'added', req.auth.userId, body.emoji);
  ok(res, { ok: true });
}

async function remove(req, res, { params }) {
  const { data: msg } = await supabase.from('messages').select('conversation_id')
    .eq('id', params.id).maybeSingle();
  if (!msg) return badRequest(res, 'Message not found');

  await supabase.from('message_reactions').delete()
    .eq('message_id', params.id).eq('user_id', req.auth.userId).eq('emoji', params.emoji);

  await broadcastReaction(msg.conversation_id, params.id, 'removed', req.auth.userId, params.emoji);
  ok(res, { ok: true });
}

async function list(req, res, { params }) {
  const { data } = await supabase.from('message_reactions')
    .select('user_id, emoji, created_at').eq('message_id', params.id);
  ok(res, { reactions: data || [] });
}

async function broadcastReaction(conversationId, messageId, action, userId, emoji) {
  const { data: members } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', conversationId).is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id);
  if (!memberIds.length) return;
  const { data: devices } = await supabase.from('devices').select('id')
    .in('user_id', memberIds).is('revoked_at', null);
  broadcastToDevices((devices || []).map((d) => d.id), () => ({
    type: action === 'added' ? 'reaction.added' : 'reaction.removed',
    message_id: messageId, user_id: userId, emoji,
  }));
}

module.exports = { add, remove, list };
