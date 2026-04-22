'use strict';

const { supabase } = require('../db/supabase');
const { ok, created, badRequest, forbidden, readJson, serverError } = require('../util/response');
const { randomBase64Url } = require('../util/crypto');
const { audit } = require('../util/audit');

async function list(req, res, { query }) {
  const wsId = query.workspace_id;
  if (!wsId) return badRequest(res, 'workspace_id required');
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', wsId).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res);
  const { data } = await supabase.from('webhooks').select('id, url, events, active, created_at, last_success_at, last_failure_at, failure_count')
    .eq('workspace_id', wsId).order('created_at', { ascending: false });
  ok(res, { webhooks: data || [] });
}

async function create(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.workspace_id || !body?.url || !Array.isArray(body?.events)) {
    return badRequest(res, 'workspace_id, url, events[] required');
  }
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', body.workspace_id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res);

  const secret = randomBase64Url(32);
  const { data, error } = await supabase.from('webhooks').insert({
    workspace_id: body.workspace_id,
    url: body.url,
    events: body.events,
    secret,
    created_by_user: req.auth.userId,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: body.workspace_id,
    action: 'webhook.create', targetType: 'webhook', targetId: data.id, req });
  // Return secret ONCE — store it carefully on the receiver end.
  created(res, { webhook: { ...data, secret } });
}

async function destroy(req, res, { params }) {
  const { data: hook } = await supabase.from('webhooks').select('workspace_id').eq('id', params.id).maybeSingle();
  if (!hook) return ok(res, { ok: true });
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', hook.workspace_id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res);
  await supabase.from('webhooks').delete().eq('id', params.id);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: hook.workspace_id,
    action: 'webhook.delete', targetType: 'webhook', targetId: params.id, req });
  ok(res, { ok: true });
}

module.exports = { list, create, destroy };
