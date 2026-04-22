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
    .from('users').select('id, username, display_name, avatar_url, account_type, last_seen_at')
    .eq('id', params.id).is('deleted_at', null).maybeSingle();
  if (!user) return notFound(res);
  ok(res, { user });
}

module.exports = { me, updateMe, search, getUser };
