'use strict';

/**
 * Communities — Workspace-of-Workspaces. Minimal CRUD + membership.
 *
 *   GET    /communities                       my communities
 *   POST   /communities                       create
 *   GET    /communities/:id                   detail (members + workspaces)
 *   PUT    /communities/:id                   update (owner/admin)
 *   DELETE /communities/:id                   soft-delete (owner only)
 *   POST   /communities/:id/workspaces        attach a workspace to it
 *   DELETE /communities/:id/workspaces/:ws_id detach
 *   POST   /communities/:id/members           add user
 *   DELETE /communities/:id/members/:user_id  remove
 */

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');

async function getMyRole(req, communityId) {
  const { data } = await supabase.from('community_members').select('role')
    .eq('community_id', communityId).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  return data?.role || null;
}

async function list(req, res) {
  const { data: my } = await supabase.from('community_members')
    .select('community_id, role, communities:community_id (id, slug, name, description, avatar_url, visibility, created_at, deleted_at)')
    .eq('user_id', req.auth.userId).is('left_at', null);
  const out = (my || [])
    .filter((m) => m.communities && !(m.communities.deleted_at))
    .map((m) => ({ ...m.communities, my_role: m.role }));
  ok(res, { communities: out });
}

async function create(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.name) return badRequest(res, 'name required');
  const slug = body.slug
    ? String(body.slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)
    : null;

  const { data, error } = await supabase.from('communities').insert({
    name: String(body.name).slice(0, 80),
    slug,
    description: body.description ? String(body.description).slice(0, 500) : null,
    visibility: ['private', 'invite_only', 'public'].includes(body.visibility)
      ? body.visibility : 'private',
    created_by: req.auth.userId,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  await supabase.from('community_members').insert({
    community_id: data.id, user_id: req.auth.userId, role: 'owner',
  });

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'community.create', targetType: 'community', targetId: data.id, req,
  });

  created(res, { community: data });
}

async function getOne(req, res, { params }) {
  const role = await getMyRole(req, params.id);
  if (!role) return forbidden(res);
  const [{ data: community }, { data: members }, { data: workspaces }] = await Promise.all([
    supabase.from('communities').select('*').eq('id', params.id).maybeSingle(),
    supabase.from('community_members').select('user_id, role, joined_at, users:user_id (id, username, display_name, avatar_url)')
      .eq('community_id', params.id).is('left_at', null),
    supabase.from('workspaces').select('id, name, slug, created_at').eq('community_id', params.id).is('deleted_at', null),
  ]);
  if (!community || community.deleted_at) return notFound(res);
  ok(res, { community: { ...community, my_role: role }, members: members || [], workspaces: workspaces || [] });
}

async function update(req, res, { params }) {
  const role = await getMyRole(req, params.id);
  if (!role || !['owner', 'admin'].includes(role)) return forbidden(res);
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const patch = {};
  if (body.name !== undefined)        patch.name = String(body.name).slice(0, 80);
  if (body.description !== undefined) patch.description = body.description ? String(body.description).slice(0, 500) : null;
  if (body.avatar_url !== undefined)  patch.avatar_url = body.avatar_url;
  if (body.visibility !== undefined && ['private', 'invite_only', 'public'].includes(body.visibility))
    patch.visibility = body.visibility;
  if (Object.keys(patch).length === 0) return ok(res, {});
  const { data, error } = await supabase.from('communities').update(patch).eq('id', params.id).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { community: data });
}

async function destroy(req, res, { params }) {
  const role = await getMyRole(req, params.id);
  if (role !== 'owner') return forbidden(res, 'owner only');
  await supabase.from('communities').update({ deleted_at: new Date().toISOString() }).eq('id', params.id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'community.delete', targetType: 'community', targetId: params.id, req,
  });
  ok(res, { ok: true });
}

async function attachWorkspace(req, res, { params }) {
  const role = await getMyRole(req, params.id);
  if (!role || !['owner', 'admin'].includes(role)) return forbidden(res);
  const body = await readJson(req).catch(() => null);
  if (!body?.workspace_id) return badRequest(res, 'workspace_id required');
  // Caller must also be admin of that workspace.
  const { data: w } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', body.workspace_id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!w || !['owner', 'admin'].includes(w.role)) return forbidden(res, 'workspace admin required');
  await supabase.from('workspaces').update({ community_id: params.id }).eq('id', body.workspace_id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'community.attach_workspace', targetType: 'community', targetId: params.id,
    metadata: { workspace_id: body.workspace_id }, req,
  });
  ok(res, { ok: true });
}

async function detachWorkspace(req, res, { params }) {
  const role = await getMyRole(req, params.id);
  if (!role || !['owner', 'admin'].includes(role)) return forbidden(res);
  await supabase.from('workspaces').update({ community_id: null })
    .eq('id', params.ws_id).eq('community_id', params.id);
  ok(res, { ok: true });
}

async function addMember(req, res, { params }) {
  const role = await getMyRole(req, params.id);
  if (!role || !['owner', 'admin'].includes(role)) return forbidden(res);
  const body = await readJson(req).catch(() => null);
  if (!body?.user_id) return badRequest(res, 'user_id required');
  const newRole = ['admin', 'member', 'guest'].includes(body.role) ? body.role : 'member';
  await supabase.from('community_members').upsert({
    community_id: params.id, user_id: body.user_id, role: newRole, left_at: null,
  }, { onConflict: 'community_id,user_id' });
  ok(res, { ok: true });
}

async function removeMember(req, res, { params }) {
  const role = await getMyRole(req, params.id);
  if (!role || !['owner', 'admin'].includes(role)) return forbidden(res);
  if (params.user_id === req.auth.userId && role === 'owner') {
    return badRequest(res, 'transfer ownership before leaving');
  }
  await supabase.from('community_members').update({ left_at: new Date().toISOString() })
    .eq('community_id', params.id).eq('user_id', params.user_id);
  ok(res, { ok: true });
}

module.exports = {
  list, create, getOne, update, destroy,
  attachWorkspace, detachWorkspace, addMember, removeMember,
};
