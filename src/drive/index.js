'use strict';

/**
 * Workspace Drive — curated, non-chat-tied file library per workspace.
 *
 * Files live in media_objects (already E2E-sealed per-device). This
 * table just adds a "folder" layer with name + description + tags so
 * members can browse + search outside of any chat context.
 *
 *   GET    /workspaces/:id/files              list + search
 *   POST   /workspaces/:id/files              attach an existing media_object
 *   GET    /workspaces/:id/files/:file_id     detail
 *   PUT    /workspaces/:id/files/:file_id     rename/retag
 *   DELETE /workspaces/:id/files/:file_id     soft-delete
 *   POST   /workspaces/:id/files/:file_id/pin
 */

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');

async function requireMember(req, workspaceId) {
  const { data: m } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  return m || null;
}

async function list(req, res, { params, query }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);

  const q = String(query.q || '').trim();
  const tag = query.tag ? String(query.tag) : null;
  const folder = query.folder ? String(query.folder) : null;
  const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));

  let qb = supabase.from('workspace_files')
    .select('*, uploader:uploader_user_id (id, username, display_name, avatar_url), media:media_object_id (id, mime_type, size_bytes, created_at)')
    .eq('workspace_id', params.id)
    .is('deleted_at', null)
    .order('is_folder', { ascending: false })   // folders first
    .order('pinned_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  // Folder scope: when no `?folder=` is given we list the root (parent
  // is null). Listing inside a folder filters by parent_folder_id.
  if (folder) qb = qb.eq('parent_folder_id', folder);
  else        qb = qb.is('parent_folder_id', null);
  if (q) qb = qb.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
  if (tag) qb = qb.contains('tags', [tag]);

  // Hide superseded versions: we only want the highest-`version` row
  // per `version_group_id`. Cheap path — fetch all then dedupe in JS.
  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  const byGroup = new Map();
  const naked = [];
  for (const row of data || []) {
    if (!row.version_group_id) { naked.push(row); continue; }
    const cur = byGroup.get(row.version_group_id);
    if (!cur || (row.version || 1) > (cur.version || 1)) byGroup.set(row.version_group_id, row);
  }
  ok(res, { files: [...naked, ...byGroup.values()] });
}

/**
 * POST /workspaces/:id/files/folders   { name, parent_folder_id? }
 */
async function createFolder(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);
  const body = await readJson(req).catch(() => null);
  if (!body?.name) return badRequest(res, 'name required');

  const row = {
    workspace_id: params.id,
    uploader_user_id: req.auth.userId,
    media_object_id: null,
    name: String(body.name).slice(0, 200),
    description: null,
    tags: [],
    is_folder: true,
    parent_folder_id: body.parent_folder_id || null,
  };
  const { data, error } = await supabase.from('workspace_files').insert(row).select('*').single();
  if (error) return serverError(res, 'Folder create failed', error);
  ok(res, { folder: data });
}

/**
 * GET /workspaces/:id/files/:file_id/versions
 * Lists every prior version in the same group (newest first).
 */
async function listVersions(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);
  const { data: file } = await supabase.from('workspace_files')
    .select('version_group_id').eq('id', params.file_id).maybeSingle();
  if (!file?.version_group_id) return ok(res, { versions: [] });
  const { data } = await supabase.from('workspace_files')
    .select('id, version, name, created_at, uploader_user_id, media_object_id, deleted_at')
    .eq('version_group_id', file.version_group_id)
    .is('deleted_at', null)
    .order('version', { ascending: false });
  ok(res, { versions: data || [] });
}

async function attach(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);

  const body = await readJson(req).catch(() => null);
  if (!body?.media_object_id) return badRequest(res, 'media_object_id required');
  if (!body?.name || typeof body.name !== 'string') return badRequest(res, 'name required');

  // Verify the uploader uploaded this media object. Workspace members
  // can only expose media they uploaded themselves — no reposting other
  // people's ciphertexts into the drive.
  const { data: media } = await supabase.from('media_objects')
    .select('id, uploader_user_id').eq('id', body.media_object_id).maybeSingle();
  if (!media) return notFound(res, 'media_object not found');
  if (media.uploader_user_id !== req.auth.userId) {
    return forbidden(res, 'can only attach own uploads');
  }

  // Versioning: if a non-folder with the same `name` already exists in
  // the same parent folder, we promote this upload to v(N+1) of that
  // group. Otherwise it gets a fresh group_id at v1.
  const parent = body.parent_folder_id || null;
  const cleanName = String(body.name).slice(0, 200);
  const { data: prev } = await supabase.from('workspace_files')
    .select('version, version_group_id').eq('workspace_id', params.id)
    .eq('name', cleanName).is('deleted_at', null).eq('is_folder', false)
    .eq(parent ? 'parent_folder_id' : 'workspace_id', parent || params.id)
    .order('version', { ascending: false }).limit(1);
  const groupId = prev?.[0]?.version_group_id || crypto.randomUUID?.() || require('node:crypto').randomUUID();
  const nextVersion = (prev?.[0]?.version || 0) + 1;

  const row = {
    workspace_id: params.id,
    uploader_user_id: req.auth.userId,
    media_object_id: media.id,
    name: cleanName,
    description: body.description ? String(body.description).slice(0, 1000) : null,
    tags: Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).slice(0, 40)).slice(0, 20)
      : [],
    parent_folder_id: parent,
    is_folder: false,
    version: nextVersion,
    version_group_id: groupId,
  };
  const { data, error } = await supabase.from('workspace_files').insert(row).select('*').single();
  if (error) return serverError(res, 'Attach failed', error);

  // Cap version history at 5 by soft-deleting older revisions.
  const { data: olderRows } = await supabase.from('workspace_files')
    .select('id, version').eq('version_group_id', groupId).is('deleted_at', null)
    .order('version', { ascending: false });
  if ((olderRows?.length || 0) > 5) {
    const stale = olderRows.slice(5).map((r) => r.id);
    if (stale.length) {
      await supabase.from('workspace_files')
        .update({ deleted_at: new Date().toISOString() }).in('id', stale);
    }
  }

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'drive.attach', targetType: 'workspace_file', targetId: data.id,
    metadata: { workspace_id: params.id, media_object_id: media.id, name: row.name },
    req, workspaceId: params.id,
  });

  created(res, { file: data });
}

async function getOne(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);
  const { data, error } = await supabase.from('workspace_files')
    .select('*, uploader:uploader_user_id (id, username, display_name, avatar_url), media:media_object_id (id, mime_type, size_bytes, created_at)')
    .eq('id', params.file_id).eq('workspace_id', params.id).maybeSingle();
  if (error) return serverError(res, 'Query failed', error);
  if (!data || data.deleted_at) return notFound(res);
  ok(res, { file: data });
}

async function update(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);

  const { data: file } = await supabase.from('workspace_files')
    .select('uploader_user_id').eq('id', params.file_id).maybeSingle();
  if (!file) return notFound(res);
  const canEdit = file.uploader_user_id === req.auth.userId || ['owner','admin'].includes(me.role);
  if (!canEdit) return forbidden(res);

  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const patch = {};
  if (body.name !== undefined)        patch.name = String(body.name).slice(0, 200);
  if (body.description !== undefined) patch.description = body.description ? String(body.description).slice(0, 1000) : null;
  if (Array.isArray(body.tags))       patch.tags = body.tags.map((t) => String(t).slice(0, 40)).slice(0, 20);

  if (Object.keys(patch).length === 0) return ok(res, { ok: true });
  const { data, error } = await supabase.from('workspace_files').update(patch)
    .eq('id', params.file_id).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { file: data });
}

async function destroy(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);
  const { data: file } = await supabase.from('workspace_files')
    .select('uploader_user_id').eq('id', params.file_id).maybeSingle();
  if (!file) return notFound(res);
  const canDel = file.uploader_user_id === req.auth.userId || ['owner','admin'].includes(me.role);
  if (!canDel) return forbidden(res);
  await supabase.from('workspace_files').update({ deleted_at: new Date().toISOString() })
    .eq('id', params.file_id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'drive.delete', targetType: 'workspace_file', targetId: params.file_id,
    req, workspaceId: params.id,
  });
  ok(res, { ok: true });
}

async function pin(req, res, { params }) {
  const me = await requireMember(req, params.id);
  if (!me || !['owner','admin'].includes(me.role)) return forbidden(res);
  const body = await readJson(req).catch(() => ({})) || {};
  const pinned = !!body.pinned;
  await supabase.from('workspace_files').update({
    pinned_at: pinned ? new Date().toISOString() : null,
  }).eq('id', params.file_id).eq('workspace_id', params.id);
  ok(res, { ok: true });
}

module.exports = { list, attach, getOne, update, destroy, pin, createFolder, listVersions };
