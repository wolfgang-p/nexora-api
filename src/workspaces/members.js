'use strict';

/**
 * Workspace member directory + role / permission management.
 *
 *   GET    /workspaces/:id/members            full directory (user joined)
 *   PUT    /workspaces/:id/members/:user_id   set role + permission overrides
 *   DELETE /workspaces/:id/members/:user_id   remove a member
 *
 * Roles: owner | admin | member | guest. `permissions` is a JSONB map of
 * boolean overrides on top of the role defaults (see permissions.js).
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { DEFAULT_PERMS, effectivePerms } = require('./permissions');

const ROLES = ['owner', 'admin', 'member', 'guest'];

async function myRole(req, workspaceId) {
  const { data } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  return data?.role || null;
}

/** GET /workspaces/:id/members — directory with user details + effective perms. */
async function list(req, res, { params }) {
  const role = await myRole(req, params.id);
  if (!role) return forbidden(res);

  const { data, error } = await supabase.from('workspace_members')
    .select('user_id, role, permissions, joined_at, user:user_id (id, username, display_name, avatar_url)')
    .eq('workspace_id', params.id).is('left_at', null)
    .order('joined_at', { ascending: true });
  if (error) return serverError(res, 'Query failed', error);

  const members = (data || []).map((m) => ({
    user_id: m.user_id,
    role: m.role,
    joined_at: m.joined_at,
    permissions: m.permissions || {},
    effective: effectivePerms(m.role, m.permissions || {}),
    user: m.user || null,
  }));
  ok(res, { members, role_defaults: DEFAULT_PERMS });
}

/**
 * PUT /workspaces/:id/members/:user_id  { role?, permissions? }
 * Owner/admin only. Guards:
 *   - only an owner may grant/transfer the owner role
 *   - admins cannot modify an owner
 *   - the last remaining owner cannot be demoted (avoids orphaning)
 */
async function update(req, res, { params }) {
  const role = await myRole(req, params.id);
  if (!role || !['owner', 'admin'].includes(role)) return forbidden(res, 'Admin only');

  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const { data: target } = await supabase.from('workspace_members')
    .select('role').eq('workspace_id', params.id).eq('user_id', params.user_id)
    .is('left_at', null).maybeSingle();
  if (!target) return notFound(res, 'member not found');

  if (target.role === 'owner' && role !== 'owner') {
    return forbidden(res, 'only an owner can modify an owner');
  }

  const patch = {};
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) return badRequest(res, 'invalid role');
    if (body.role === 'owner' && role !== 'owner') {
      return forbidden(res, 'only an owner can grant the owner role');
    }
    // Don't let the last owner demote themselves into orphaning the ws.
    if (target.role === 'owner' && body.role !== 'owner') {
      const { count } = await supabase.from('workspace_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('workspace_id', params.id).eq('role', 'owner').is('left_at', null);
      if ((count || 0) <= 1) return badRequest(res, 'cannot demote the last owner');
    }
    patch.role = body.role;
  }
  if (body.permissions !== undefined && body.permissions && typeof body.permissions === 'object') {
    // Keep only known boolean keys.
    const clean = {};
    for (const k of Object.keys(DEFAULT_PERMS.member)) {
      if (typeof body.permissions[k] === 'boolean') clean[k] = body.permissions[k];
    }
    patch.permissions = clean;
  }
  if (!Object.keys(patch).length) return ok(res, { ok: true });

  const { data, error } = await supabase.from('workspace_members').update(patch)
    .eq('workspace_id', params.id).eq('user_id', params.user_id)
    .select('user_id, role, permissions').single();
  if (error) return serverError(res, 'Update failed', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'workspace.member.update', targetType: 'workspace_member', targetId: params.user_id,
    metadata: patch, req,
  });
  ok(res, { member: { ...data, effective: effectivePerms(data.role, data.permissions || {}) } });
}

/** DELETE /workspaces/:id/members/:user_id — remove (or self-leave). */
async function remove(req, res, { params }) {
  const role = await myRole(req, params.id);
  if (!role) return forbidden(res);
  const isSelf = params.user_id === req.auth.userId;
  if (!isSelf && !['owner', 'admin'].includes(role)) return forbidden(res, 'Admin only');

  const { data: target } = await supabase.from('workspace_members')
    .select('role').eq('workspace_id', params.id).eq('user_id', params.user_id)
    .is('left_at', null).maybeSingle();
  if (!target) return notFound(res, 'member not found');
  if (target.role === 'owner' && !isSelf) return forbidden(res, 'cannot remove an owner');
  if (target.role === 'owner' && isSelf) {
    const { count } = await supabase.from('workspace_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', params.id).eq('role', 'owner').is('left_at', null);
    if ((count || 0) <= 1) return badRequest(res, 'transfer ownership before leaving');
  }

  await supabase.from('workspace_members').update({ left_at: new Date().toISOString() })
    .eq('workspace_id', params.id).eq('user_id', params.user_id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: isSelf ? 'workspace.leave' : 'workspace.member.remove',
    targetType: 'workspace_member', targetId: params.user_id, req,
  });
  ok(res, { ok: true });
}

module.exports = { list, update, remove };
