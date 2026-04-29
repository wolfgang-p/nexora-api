'use strict';

/**
 * Per-user, per-conversation drafts. Stored as ciphertext sealed by
 * the writing device to the user's OWN active devices, so the server
 * never sees plaintext drafts even though they cross the API.
 *
 *   GET    /conversations/:id/draft         — pull
 *   PUT    /conversations/:id/draft         — push
 *   DELETE /conversations/:id/draft         — clear
 */

const { supabase } = require('../db/supabase');
const { ok, badRequest, forbidden, notFound, readJson, serverError } = require('../util/response');

async function get(req, res, { params }) {
  const { data: me } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', params.id)
    .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me) return forbidden(res, 'Not a member');

  const { data } = await supabase.from('drafts')
    .select('*').eq('user_id', req.auth.userId)
    .eq('conversation_id', params.id).maybeSingle();
  ok(res, { draft: data || null });
}

async function put(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.ciphertext || !body?.nonce) return badRequest(res, 'ciphertext + nonce required');

  const { data: me } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', params.id)
    .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me) return forbidden(res, 'Not a member');

  const { data, error } = await supabase.from('drafts').upsert({
    user_id: req.auth.userId,
    conversation_id: params.id,
    ciphertext: body.ciphertext,
    nonce: body.nonce,
    source_device_id: req.auth.deviceId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,conversation_id' }).select('*').single();
  if (error) return serverError(res, 'Save failed', error);
  ok(res, { draft: data });
}

async function destroy(req, res, { params }) {
  await supabase.from('drafts').delete()
    .eq('user_id', req.auth.userId).eq('conversation_id', params.id);
  ok(res, { ok: true });
}

module.exports = { get, put, destroy };
