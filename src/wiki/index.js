'use strict';

/**
 * Workspace Wiki / Notes — markdown pages per workspace.
 *
 * Pages live in `workspace_pages` (see migrations/0027). Any member can
 * read + create; the author or a workspace owner/admin can edit/delete.
 * Pages can nest via `parent_page_id` and be pinned.
 *
 *   GET    /workspaces/:id/pages              list (?q= title/body search)
 *   POST   /workspaces/:id/pages              create { title, body?, parent_page_id? }
 *   GET    /workspaces/:id/pages/:page_id     detail
 *   PUT    /workspaces/:id/pages/:page_id     update { title?, body?, pinned? }
 *   DELETE /workspaces/:id/pages/:page_id     soft-delete
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');

async function requireMember(req, workspaceId) {
  const { data: m } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  return m || null;
}

const PAGE_SELECT =
  '*, author:created_by (id, username, display_name, avatar_url), editor:updated_by (id, username, display_name, avatar_url)';

async function list(req, res, { params, query }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);

  const q = String(query.q || '').trim();
  const limit = Math.max(1, Math.min(200, Number(query.limit) || 100));

  let qb = supabase.from('workspace_pages')
    .select(PAGE_SELECT)
    .eq('workspace_id', params.id)
    .is('deleted_at', null)
    .order('pinned_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (q) qb = qb.or(`title.ilike.%${q}%,body.ilike.%${q}%`);

  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { pages: data || [] });
}

async function create(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);

  const body = await readJson(req).catch(() => null);
  if (!body?.title || typeof body.title !== 'string') return badRequest(res, 'title required');

  const row = {
    workspace_id: params.id,
    title: String(body.title).slice(0, 200),
    body: body.body ? String(body.body).slice(0, 100_000) : '',
    parent_page_id: body.parent_page_id || null,
    created_by: req.auth.userId,
    updated_by: req.auth.userId,
  };
  const { data, error } = await supabase.from('workspace_pages').insert(row).select(PAGE_SELECT).single();
  if (error) return serverError(res, 'Create failed', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'wiki.create', targetType: 'workspace_page', targetId: data.id,
    metadata: { workspace_id: params.id, title: row.title },
    req, workspaceId: params.id,
  });
  created(res, { page: data });
}

async function getOne(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);
  const { data, error } = await supabase.from('workspace_pages')
    .select(PAGE_SELECT)
    .eq('id', params.page_id).eq('workspace_id', params.id).maybeSingle();
  if (error) return serverError(res, 'Query failed', error);
  if (!data || data.deleted_at) return notFound(res);
  ok(res, { page: data });
}

async function update(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);

  const { data: page } = await supabase.from('workspace_pages')
    .select('created_by, deleted_at').eq('id', params.page_id).eq('workspace_id', params.id).maybeSingle();
  if (!page || page.deleted_at) return notFound(res);
  const canEdit = page.created_by === req.auth.userId || ['owner', 'admin'].includes(me.role);
  if (!canEdit) return forbidden(res, 'only the author or an admin can edit this page');

  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const patch = { updated_by: req.auth.userId, updated_at: new Date().toISOString() };
  if (body.title !== undefined) patch.title = String(body.title).slice(0, 200);
  if (body.body !== undefined)  patch.body = body.body ? String(body.body).slice(0, 100_000) : '';
  if (body.pinned !== undefined) patch.pinned_at = body.pinned ? new Date().toISOString() : null;

  const { data, error } = await supabase.from('workspace_pages').update(patch)
    .eq('id', params.page_id).select(PAGE_SELECT).single();
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { page: data });
}

async function destroy(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);
  const { data: page } = await supabase.from('workspace_pages')
    .select('created_by').eq('id', params.page_id).eq('workspace_id', params.id).maybeSingle();
  if (!page) return notFound(res);
  const canDel = page.created_by === req.auth.userId || ['owner', 'admin'].includes(me.role);
  if (!canDel) return forbidden(res);

  await supabase.from('workspace_pages').update({ deleted_at: new Date().toISOString() })
    .eq('id', params.page_id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'wiki.delete', targetType: 'workspace_page', targetId: params.page_id,
    req, workspaceId: params.id,
  });
  ok(res, { ok: true });
}

module.exports = { list, create, getOne, update, destroy };
