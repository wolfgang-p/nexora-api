'use strict';

/**
 * Thread endpoints.
 *
 *   GET  /messages/:id/thread           — all messages in the thread rooted at :id,
 *                                         oldest first, with per-recipient ciphertext
 *                                         for the calling device. Includes the root.
 *   POST /messages/:id/thread/read      — mark thread read up to a given message.
 *
 * The thread's root is always the first message; replies are linked via
 * messages.thread_root_id = root.id (resolved server-side when inserting
 * a reply — see send.js).
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { envelopeFor } = require('./send');

async function listThread(req, res, { params }) {
  const rootId = params.id;

  const { data: root } = await supabase.from('messages')
    .select('*, thread_root_id').eq('id', rootId).maybeSingle();
  if (!root) return notFound(res, 'Thread root not found');

  // Resolve to the real root in case :id points to a reply.
  const realRootId = root.thread_root_id || root.id;

  // Membership guard.
  const { data: mem } = await supabase.from('conversation_members').select('user_id')
    .eq('conversation_id', root.conversation_id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!mem) return forbidden(res);

  const { data: msgs, error } = await supabase.from('messages')
    .select('*')
    .or(`id.eq.${realRootId},thread_root_id.eq.${realRootId}`)
    .order('created_at', { ascending: true });
  if (error) return serverError(res, 'Query failed', error);

  const ids = (msgs || []).map((m) => m.id);
  const { data: copies } = ids.length
    ? await supabase.from('message_recipients')
        .select('message_id, ciphertext, nonce, recipient_device_id, delivered_at, read_at')
        .in('message_id', ids).eq('recipient_device_id', req.auth.deviceId)
    : { data: [] };
  const copyMap = new Map((copies || []).map((c) => [c.message_id, c]));

  const out = (msgs || []).map((m) => {
    const c = copyMap.get(m.id);
    return {
      ...envelopeFor(m),
      ciphertext: c?.ciphertext ?? null,
      nonce: c?.nonce ?? null,
      recipient_device_id: c?.recipient_device_id ?? null,
      delivered_at: c?.delivered_at ?? null,
      read_at: c?.read_at ?? null,
      reactions: [],
      poll: null,
    };
  });

  ok(res, { root_id: realRootId, messages: out });
}

async function markThreadRead(req, res, { params }) {
  const body = await readJson(req).catch(() => ({})) || {};
  const lastReadMessageId = body.last_read_message_id || null;

  const { data: root } = await supabase.from('messages')
    .select('id, conversation_id, thread_root_id').eq('id', params.id).maybeSingle();
  if (!root) return notFound(res, 'Thread root not found');
  const realRootId = root.thread_root_id || root.id;

  const { data: mem } = await supabase.from('conversation_members').select('user_id')
    .eq('conversation_id', root.conversation_id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!mem) return forbidden(res);

  await supabase.from('thread_reads').upsert({
    user_id: req.auth.userId,
    thread_root_id: realRootId,
    last_read_at: new Date().toISOString(),
    last_read_message_id: lastReadMessageId,
  }, { onConflict: 'user_id,thread_root_id' });

  ok(res, { ok: true });
}

module.exports = { listThread, markThreadRead };
