'use strict';

/**
 * Pinned messages — at most 3 per conversation, like Telegram.
 * Pinning beyond 3 unpins the oldest pin first.
 *
 *   POST   /messages/:id/pin
 *   DELETE /messages/:id/pin
 *   GET    /conversations/:id/pins
 */

const { supabase } = require('../db/supabase');
const { ok, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');

const MAX_PINS = 3;

async function pin(req, res, { params }) {
  const { data: msg } = await supabase.from('messages')
    .select('id, conversation_id, deleted_at, pinned_at')
    .eq('id', params.id).maybeSingle();
  if (!msg || msg.deleted_at) return notFound(res);

  const { data: me } = await supabase.from('conversation_members')
    .select('role').eq('conversation_id', msg.conversation_id)
    .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me) return forbidden(res, 'Not a member');

  if (msg.pinned_at) return ok(res, { message: msg });

  // Evict the oldest pin if we'd exceed the cap.
  const { data: existing } = await supabase.from('messages')
    .select('id, pinned_at').eq('conversation_id', msg.conversation_id)
    .not('pinned_at', 'is', null).is('deleted_at', null)
    .order('pinned_at', { ascending: true });
  if (existing && existing.length >= MAX_PINS) {
    const evict = existing.slice(0, existing.length - MAX_PINS + 1);
    if (evict.length) {
      await supabase.from('messages').update({ pinned_at: null, pinned_by: null })
        .in('id', evict.map((m) => m.id));
    }
  }

  const { data: updated, error } = await supabase.from('messages')
    .update({ pinned_at: new Date().toISOString(), pinned_by: req.auth.userId })
    .eq('id', params.id).select('*').single();
  if (error) return serverError(res, 'Pin failed', error);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'message.pin', targetType: 'message', targetId: params.id, req });

  ok(res, { message: updated });
}

async function unpin(req, res, { params }) {
  const { data: msg } = await supabase.from('messages')
    .select('id, conversation_id, pinned_at').eq('id', params.id).maybeSingle();
  if (!msg) return notFound(res);

  const { data: me } = await supabase.from('conversation_members')
    .select('role').eq('conversation_id', msg.conversation_id)
    .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me) return forbidden(res, 'Not a member');

  if (!msg.pinned_at) return ok(res, { ok: true });

  await supabase.from('messages')
    .update({ pinned_at: null, pinned_by: null }).eq('id', params.id);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'message.unpin', targetType: 'message', targetId: params.id, req });

  ok(res, { ok: true });
}

async function listPins(req, res, { params }) {
  const { data: me } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', params.id)
    .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me) return forbidden(res, 'Not a member');

  // Same shape as listMessages — caller must already know how to render
  // a `Message` row.
  const { data: pins } = await supabase.from('messages')
    .select('id, conversation_id, sender_user_id, sender_device_id, kind, pinned_at, pinned_by, created_at, edited_at')
    .eq('conversation_id', params.id)
    .not('pinned_at', 'is', null).is('deleted_at', null)
    .order('pinned_at', { ascending: false }).limit(MAX_PINS);

  // Resolve the per-recipient ciphertext for the calling device.
  const ids = (pins || []).map((p) => p.id);
  let recipients = [];
  if (ids.length) {
    const { data } = await supabase.from('message_recipients')
      .select('message_id, ciphertext, nonce')
      .in('message_id', ids).eq('recipient_device_id', req.auth.deviceId);
    recipients = data || [];
  }
  const byId = new Map(recipients.map((r) => [r.message_id, r]));
  const out = (pins || []).map((p) => ({
    ...p,
    ciphertext: byId.get(p.id)?.ciphertext || null,
    nonce: byId.get(p.id)?.nonce || null,
  }));
  ok(res, { pins: out });
}

module.exports = { pin, unpin, listPins };
