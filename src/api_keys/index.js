'use strict';

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, serverError } = require('../util/response');
const { randomBase64Url, sha256 } = require('../util/crypto');
const { audit } = require('../util/audit');

/**
 * GET /workspaces/:id/api-keys   (workspace admin)
 */
async function list(req, res, { params }) {
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', params.id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res);
  const { data } = await supabase.from('api_keys')
    .select('id, label, key_prefix, scopes, crm_device_id, created_at, expires_at, last_used_at, revoked_at')
    .eq('workspace_id', params.id).order('created_at', { ascending: false });
  ok(res, { api_keys: data || [] });
}

/**
 * POST /workspaces/:id/api-keys
 * Body: { label, scopes: [], expires_at?, crm_device_id? }
 * Returns the raw key string ONCE. Not retrievable again.
 */
async function create(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.label) return badRequest(res, 'label required');
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', params.id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res);

  const prefix = `koro_live_${randomBase64Url(4)}`;
  const secret = randomBase64Url(32);
  const full = `${prefix}_${secret}`;
  const hash = sha256(full);

  const { data, error } = await supabase.from('api_keys').insert({
    workspace_id: params.id,
    label: body.label,
    key_hash: hash,
    key_prefix: prefix,
    scopes: Array.isArray(body.scopes) ? body.scopes : [],
    crm_device_id: body.crm_device_id || null,
    created_by_user: req.auth.userId,
    expires_at: body.expires_at || null,
  }).select('id, label, key_prefix, scopes, crm_device_id, created_at, expires_at').single();
  if (error) return serverError(res, 'Create failed', error);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'api_key.create', targetType: 'api_key', targetId: data.id,
    metadata: { label: data.label, scopes: data.scopes }, req });

  created(res, { api_key: data, secret: full });
}

/**
 * DELETE /api-keys/:id   (workspace admin)
 */
async function revoke(req, res, { params }) {
  const { data: key } = await supabase.from('api_keys').select('workspace_id').eq('id', params.id).maybeSingle();
  if (!key) return ok(res, { ok: true });
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', key.workspace_id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res);

  await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', params.id);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: key.workspace_id,
    action: 'api_key.revoke', targetType: 'api_key', targetId: params.id, req });
  ok(res, { ok: true });
}

module.exports = { list, create, revoke };
