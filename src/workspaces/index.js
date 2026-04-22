'use strict';

const { supabase } = require('../db/supabase');
const { ok, created, notFound, badRequest, forbidden, readJson, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { randomBase64Url } = require('../util/crypto');

async function list(req, res) {
  const { data } = await supabase
    .from('workspace_members')
    .select('role, workspace:workspaces!inner(*)')
    .eq('user_id', req.auth.userId).is('left_at', null);
  const workspaces = (data || [])
    .filter((r) => r.workspace && !r.workspace.deleted_at)
    .map((r) => ({ ...r.workspace, my_role: r.role }));
  ok(res, { workspaces });
}

async function create(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.name) return badRequest(res, 'name required');
  const slug = body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const { data: ws, error } = await supabase.from('workspaces').insert({
    name: body.name, slug, description: body.description || null,
    created_by: req.auth.userId,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  await supabase.from('workspace_members').insert({
    workspace_id: ws.id, user_id: req.auth.userId, role: 'owner',
  });
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: ws.id,
    action: 'workspace.create', targetType: 'workspace', targetId: ws.id, req });
  created(res, { workspace: ws });
}

async function get(req, res, { params }) {
  const { data: ws } = await supabase.from('workspaces').select('*').eq('id', params.id).maybeSingle();
  if (!ws || ws.deleted_at) return notFound(res);
  const { data: me } = await supabase.from('workspace_members')
    .select('role').eq('workspace_id', params.id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me) return forbidden(res);
  const { data: members } = await supabase.from('workspace_members')
    .select('user_id, role, joined_at')
    .eq('workspace_id', params.id).is('left_at', null);
  const { data: channels } = await supabase.from('conversations')
    .select('id, title, description, avatar_url, updated_at')
    .eq('workspace_id', params.id).eq('kind', 'channel').is('deleted_at', null);
  ok(res, { workspace: { ...ws, my_role: me.role }, members, channels });
}

async function update(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', params.id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res, 'Admin only');
  const patch = {};
  for (const k of ['name', 'description', 'avatar_url', 'announcement']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (!Object.keys(patch).length) return ok(res, { ok: true });
  const { data, error } = await supabase.from('workspaces').update(patch)
    .eq('id', params.id).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'workspace.update', targetType: 'workspace', targetId: params.id, metadata: patch, req });
  ok(res, { workspace: data });
}

async function destroy(req, res, { params }) {
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', params.id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (me?.role !== 'owner') return forbidden(res, 'Owner only');
  await supabase.from('workspaces').update({ deleted_at: new Date().toISOString() })
    .eq('id', params.id);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'workspace.delete', targetType: 'workspace', targetId: params.id, req });
  ok(res, { ok: true });
}

async function createInvite(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', params.id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res);
  const code = randomBase64Url(10).toLowerCase();
  const { data, error } = await supabase.from('workspace_invites').insert({
    workspace_id: params.id, code, role: body?.role || 'member',
    created_by: req.auth.userId,
    max_uses: body?.max_uses || null,
    expires_at: body?.expires_at || null,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);
  created(res, { invite: data });
}

async function joinByCode(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.code) return badRequest(res, 'code required');
  const { data: invite } = await supabase.from('workspace_invites').select('*')
    .eq('code', body.code).is('revoked_at', null).maybeSingle();
  if (!invite) return notFound(res, 'Invite not found');
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return forbidden(res, 'Expired');
  if (invite.max_uses && invite.uses >= invite.max_uses) return forbidden(res, 'Exhausted');

  await supabase.from('workspace_members').upsert({
    workspace_id: invite.workspace_id, user_id: req.auth.userId, role: invite.role,
  }, { onConflict: 'workspace_id,user_id' });
  await supabase.from('workspace_invites').update({ uses: invite.uses + 1 }).eq('id', invite.id);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: invite.workspace_id,
    action: 'workspace.join', targetType: 'workspace', targetId: invite.workspace_id, req });
  ok(res, { workspace_id: invite.workspace_id });
}

module.exports = { list, create, get, update, destroy, createInvite, joinByCode };
