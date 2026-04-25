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
  const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));

  let qb = supabase.from('workspace_files')
    .select('*, uploader:uploader_user_id (id, username, display_name, avatar_url), media:media_object_id (id, mime_type, size_bytes, created_at)')
    .eq('workspace_id', params.id)
    .is('deleted_at', null)
    .order('pinned_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (q) qb = qb.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
  if (tag) qb = qb.contains('tags', [tag]);

  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { files: data || [] });
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

  const row = {
    workspace_id: params.id,
    uploader_user_id: req.auth.userId,
    media_object_id: media.id,
    name: String(body.name).slice(0, 200),
    description: body.description ? String(body.description).slice(0, 1000) : null,
    tags: Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).slice(0, 40)).slice(0, 20)
      : [],
  };
  const { data, error } = await supabase.from('workspace_files').insert(row).select('*').single();
  if (error) return serverError(res, 'Attach failed', error);

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

module.exports = { list, attach, getOne, update, destroy, pin };
