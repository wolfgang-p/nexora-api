'use strict';

const { supabase } = require('../db/supabase');
const { ok, badRequest, notFound, readJson, serverError } = require('../util/response');
const { sanitizeUser } = require('../auth/otp');

/**
 * GET /users/me
 */
async function me(req, res) {
  const { data: user } = await supabase
    .from('users').select('*').eq('id', req.auth.userId).maybeSingle();
  if (!user) return notFound(res);
  ok(res, { user: sanitizeUser(user) });
}

/**
 * PUT /users/me   { display_name?, username?, avatar_url?, locale? }
 */
async function updateMe(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const patch = {};
  for (const k of ['display_name', 'username', 'avatar_url', 'locale']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (patch.username && !/^[a-z0-9_.]{3,30}$/i.test(patch.username)) {
    return badRequest(res, 'Invalid username');
  }
  if (Object.keys(patch).length === 0) return ok(res, { ok: true });

  const { data, error } = await supabase.from('users').update(patch)
    .eq('id', req.auth.userId).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { user: sanitizeUser(data) });
}

/**
 * GET /users/search?q=<phone|@username>
 */
async function search(req, res, { query }) {
  const q = (query.q || '').trim();
  if (q.length < 3) return ok(res, { users: [] });

  let builder = supabase.from('users')
    .select('id, username, display_name, avatar_url, account_type')
    .is('deleted_at', null).limit(20);
  if (q.startsWith('+')) builder = builder.eq('phone_e164', q);
  else if (q.startsWith('@')) builder = builder.ilike('username', `${q.slice(1)}%`);
  else builder = builder.or(`username.ilike.${q}%,display_name.ilike.%${q}%`);

  const { data } = await builder;
  ok(res, { users: data || [] });
}

/**
 * GET /users/:id
 */
async function getUser(req, res, { params }) {
  const { data: user } = await supabase
    .from('users')
    .select('id, username, display_name, avatar_url, account_type, last_seen_at, bio, status_text')
    .eq('id', params.id).is('deleted_at', null).maybeSingle();
  if (!user) return notFound(res);
  ok(res, { user });
}

/**
 * POST /users/discover   { phone_hashes: [sha256(+49…), …] }
 *
 * Contacts sync. The mobile client hashes every address-book phone
 * number (SHA-256 of the E.164 string, NO pepper, so hashes match
 * across users) and sends the list. We return the subset of those
 * hashes that correspond to Koro users, with minimal profile fields.
 * We never reveal cleartext phone numbers.
 */
async function discover(req, res) {
  const body = await readJson(req).catch(() => null);
  const hashes = Array.isArray(body?.phone_hashes) ? body.phone_hashes : null;
  if (!hashes) return badRequest(res, 'phone_hashes[] required');
  // Clamp to avoid pathological payloads (address books can be huge).
  const trimmed = hashes.slice(0, 5000)
    .filter((h) => typeof h === 'string' && /^[a-f0-9]{64}$/i.test(h));

  if (trimmed.length === 0) return ok(res, { matches: [] });

  const { data } = await supabase
    .from('users')
    .select('id, phone_hash, username, display_name, avatar_url')
    .is('deleted_at', null)
    .in('phone_hash', trimmed);

  // Don't match the caller themselves — they're already there.
  const matches = (data || [])
    .filter((u) => u.id !== req.auth.userId)
    .map((u) => ({
      id: u.id,
      phone_hash: u.phone_hash,
      username: u.username,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
    }));

  ok(res, { matches });
}

/**
 * POST /users/:id/block   (authed)
 */
async function block(req, res, { params }) {
  if (params.id === req.auth.userId) return badRequest(res, 'Cannot block yourself');
  const body = await readJson(req).catch(() => null);
  const { error } = await supabase.from('user_blocks').upsert({
    blocker_user_id: req.auth.userId,
    blocked_user_id: params.id,
    reason: body?.reason || null,
  }, { onConflict: 'blocker_user_id,blocked_user_id' });
  if (error) return serverError(res, 'Block failed', error);
  ok(res, { ok: true });
}

/**
 * DELETE /users/:id/block   (unblock)
 */
async function unblock(req, res, { params }) {
  await supabase.from('user_blocks').delete()
    .eq('blocker_user_id', req.auth.userId)
    .eq('blocked_user_id', params.id);
  ok(res, { ok: true });
}

/**
 * GET /users/blocked — list of user_ids I've blocked.
 */
async function listBlocked(req, res) {
  const { data } = await supabase.from('user_blocks')
    .select('blocked_user_id, reason, created_at, users:blocked_user_id (id, username, display_name, avatar_url, phone_e164)')
    .eq('blocker_user_id', req.auth.userId)
    .order('created_at', { ascending: false });
  const blocks = (data || []).map((b) => ({
    blocked_user_id: b.blocked_user_id,
    reason: b.reason,
    created_at: b.created_at,
    user: Array.isArray(b.users) ? b.users[0] : b.users,
  }));
  ok(res, { blocks });
}

module.exports = { me, updateMe, search, getUser, discover, block, unblock, listBlocked };
