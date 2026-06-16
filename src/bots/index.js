'use strict';

/**
 * Named bots — a developer-facing programmatic identity in a workspace.
 *
 * A bot is a real `users` row (is_bot = true) so its name + avatar render
 * correctly everywhere, plus an `api_bot` device (its E2E identity), an
 * api_key (crm_device_id → that device, so the key authenticates AS the bot),
 * and a `bots` management row.
 *
 * E2E: the bot's device SECRET key is generated in the developer's browser
 * (the portal) and NEVER reaches the server. The create/rotate endpoints take
 * the bot's PUBLIC key and return the api-key secret exactly once.
 *
 *   GET    /workspaces/:id/bots
 *   POST   /workspaces/:id/bots                 { name, username?, avatar_url?, identity_public_key }
 *   PUT    /workspaces/:id/bots/:bot_id         { name?, username?, avatar_url? }
 *   DELETE /workspaces/:id/bots/:bot_id
 *   POST   /workspaces/:id/bots/:bot_id/rotate-key
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { randomBase64Url, sha256, deviceFingerprint } = require('../util/crypto');
const { audit } = require('../util/audit');

const DEFAULT_BOT_SCOPES = ['messages:read', 'messages:write', 'conversations:read', 'conversations:write'];

async function requireAdmin(req, workspaceId) {
  const { data: m } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!m) return { role: null, ok: false };
  return { role: m.role, ok: ['owner', 'admin'].includes(m.role) };
}

const BOT_SELECT =
  'id, user_id, device_id, workspace_id, api_key_id, created_at, deleted_at, ' +
  'user:user_id (id, display_name, username, avatar_url, is_bot), ' +
  'api_key:api_key_id (id, key_prefix, scopes, last_used_at, revoked_at)';

/** Mint a fresh api_key bound to the bot device. Returns { row, secret }. */
async function mintKey(workspaceId, label, crmDeviceId, createdByUser) {
  const prefix = `koro_live_${randomBase64Url(4)}`;
  const secret = randomBase64Url(32);
  const full = `${prefix}_${secret}`;
  const { data, error } = await supabase.from('api_keys').insert({
    workspace_id: workspaceId,
    label,
    key_hash: sha256(full),
    key_prefix: prefix,
    scopes: DEFAULT_BOT_SCOPES,
    crm_device_id: crmDeviceId,
    created_by_user: createdByUser,
  }).select('id, key_prefix').single();
  if (error) throw error;
  return { row: data, secret: full };
}

async function list(req, res, { params }) {
  const me = await requireAdmin(req, params.id);
  if (!me.ok) return forbidden(res);
  const { data, error } = await supabase.from('bots')
    .select(BOT_SELECT)
    .eq('workspace_id', params.id).is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { bots: data || [] });
}

async function create(req, res, { params }) {
  const me = await requireAdmin(req, params.id);
  if (!me.ok) return forbidden(res, 'Admin only');

  const body = await readJson(req).catch(() => null);
  const name = (body?.name || '').toString().trim();
  if (!name) return badRequest(res, 'name required');
  const pub = (body?.identity_public_key || '').toString();
  if (!pub) return badRequest(res, 'identity_public_key required');

  let pkBuf;
  try { pkBuf = Buffer.from(pub, 'base64'); } catch { return badRequest(res, 'identity_public_key invalid'); }
  if (pkBuf.length < 16 || pkBuf.length > 256) return badRequest(res, 'identity_public_key has unreasonable length');

  const username = body?.username ? String(body.username).trim().replace(/^@/, '').slice(0, 32) : null;

  // 1) Bot user (is_bot, no phone).
  const { data: botUser, error: uErr } = await supabase.from('users').insert({
    phone_e164: null,
    is_bot: true,
    display_name: name.slice(0, 80),
    username,
    avatar_url: body?.avatar_url || null,
    identity_public_key: pub,
  }).select('id, display_name, username, avatar_url').single();
  if (uErr) {
    if (String(uErr.message || '').includes('username')) return badRequest(res, 'username already taken');
    return serverError(res, 'Bot user create failed', uErr);
  }

  // 2) Bot device (api_bot kind), carrying the same public identity key.
  const { data: device, error: dErr } = await supabase.from('devices').insert({
    user_id: botUser.id,
    kind: 'api_bot',
    label: `${name} (bot)`,
    identity_public_key: pub,
    fingerprint: deviceFingerprint(pkBuf),
  }).select('id, fingerprint').single();
  if (dErr) { await supabase.from('users').delete().eq('id', botUser.id); return serverError(res, 'Bot device create failed', dErr); }

  // 3) API key bound to the device.
  let key;
  try { key = await mintKey(params.id, `${name} bot key`, device.id, req.auth.userId); }
  catch (err) {
    await supabase.from('devices').delete().eq('id', device.id);
    await supabase.from('users').delete().eq('id', botUser.id);
    return serverError(res, 'Bot key create failed', err);
  }

  // 4) Bots management row.
  const { data: bot, error: bErr } = await supabase.from('bots').insert({
    user_id: botUser.id,
    device_id: device.id,
    workspace_id: params.id,
    api_key_id: key.row.id,
    created_by_user: req.auth.userId,
  }).select(BOT_SELECT).single();
  if (bErr) return serverError(res, 'Bot create failed', bErr);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'bot.create', targetType: 'bot', targetId: bot.id,
    metadata: { name, username, bot_user_id: botUser.id }, req,
  });

  created(res, {
    bot,
    // Shown exactly once. The bot SECRET key was generated in the browser and
    // is held by the developer — we only echo back the api-key secret here.
    secret: key.secret,
    fingerprint: device.fingerprint,
  });
}

async function update(req, res, { params }) {
  const me = await requireAdmin(req, params.id);
  if (!me.ok) return forbidden(res);
  const { data: bot } = await supabase.from('bots')
    .select('id, user_id, deleted_at').eq('id', params.bot_id).eq('workspace_id', params.id).maybeSingle();
  if (!bot || bot.deleted_at) return notFound(res);

  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const patch = {};
  if (body.name !== undefined) patch.display_name = String(body.name).slice(0, 80);
  if (body.username !== undefined) patch.username = body.username ? String(body.username).replace(/^@/, '').slice(0, 32) : null;
  if (body.avatar_url !== undefined) patch.avatar_url = body.avatar_url || null;
  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString();
    const { error } = await supabase.from('users').update(patch).eq('id', bot.user_id);
    if (error) {
      if (String(error.message || '').includes('username')) return badRequest(res, 'username already taken');
      return serverError(res, 'Update failed', error);
    }
    await supabase.from('bots').update({ updated_at: new Date().toISOString() }).eq('id', bot.id);
  }
  const { data: fresh } = await supabase.from('bots').select(BOT_SELECT).eq('id', bot.id).single();
  ok(res, { bot: fresh });
}

async function destroy(req, res, { params }) {
  const me = await requireAdmin(req, params.id);
  if (!me.ok) return forbidden(res);
  const { data: bot } = await supabase.from('bots')
    .select('id, user_id, device_id, api_key_id').eq('id', params.bot_id).eq('workspace_id', params.id).maybeSingle();
  if (!bot) return notFound(res);

  const now = new Date().toISOString();
  await supabase.from('bots').update({ deleted_at: now }).eq('id', bot.id);
  await supabase.from('users').update({ deleted_at: now }).eq('id', bot.user_id);
  if (bot.device_id) await supabase.from('devices').update({ revoked_at: now, revoked_reason: 'bot deleted' }).eq('id', bot.device_id);
  if (bot.api_key_id) await supabase.from('api_keys').update({ revoked_at: now }).eq('id', bot.api_key_id);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'bot.delete', targetType: 'bot', targetId: bot.id, req,
  });
  ok(res, { ok: true });
}

async function rotateKey(req, res, { params }) {
  const me = await requireAdmin(req, params.id);
  if (!me.ok) return forbidden(res);
  const { data: bot } = await supabase.from('bots')
    .select('id, device_id, api_key_id, user:user_id (display_name)').eq('id', params.bot_id).eq('workspace_id', params.id).maybeSingle();
  if (!bot || !bot.device_id) return notFound(res);

  let key;
  try { key = await mintKey(params.id, `${bot.user?.display_name || 'Bot'} bot key`, bot.device_id, req.auth.userId); }
  catch (err) { return serverError(res, 'Key rotation failed', err); }

  // Revoke the old key, point the bot at the new one.
  if (bot.api_key_id) await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', bot.api_key_id);
  await supabase.from('bots').update({ api_key_id: key.row.id, updated_at: new Date().toISOString() }).eq('id', bot.id);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'bot.rotate_key', targetType: 'bot', targetId: bot.id, req,
  });
  ok(res, { secret: key.secret, key_prefix: key.row.key_prefix });
}

module.exports = { list, create, update, destroy, rotateKey };
