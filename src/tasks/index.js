'use strict';

const { supabase } = require('../db/supabase');
const { ok, created, badRequest, notFound, forbidden, readJson, serverError } = require('../util/response');
const { audit } = require('../util/audit');

async function list(req, res, { query }) {
  // Left-join the source message so every task from a chat carries a
  // `source_conversation_id` — the client can render "Aus #Chat" without
  // a second round-trip.
  let q = supabase.from('tasks').select(`
    *,
    source_message:messages!tasks_source_message_id_fkey(id, conversation_id)
  `).is('deleted_at', null);
  if (query.workspace_id) q = q.eq('workspace_id', query.workspace_id);
  if (query.assignee_id) q = q.eq('assignee_user_id', query.assignee_id);
  if (query.status) q = q.eq('status', query.status);
  if (query.source) q = q.eq('source', query.source);
  if (query.mine === 'true' || query.assignee_id === 'me') {
    q = q.or(`creator_user_id.eq.${req.auth.userId},assignee_user_id.eq.${req.auth.userId}`);
  }
  q = q.order('created_at', { ascending: false }).limit(
    Math.min(Number(query.limit) || 100, 500),
  );
  const { data, error } = await q;
  if (error) return serverError(res, 'Query failed', error);
  // Flatten the join into a top-level field so TS clients don't have to
  // chase a nested object.
  const tasks = (data || []).map((t) => ({
    ...t,
    source_conversation_id: t.source_message?.conversation_id || null,
    source_message: undefined,
  }));
  ok(res, { tasks });
}

async function create(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.title) return badRequest(res, 'title required');
  const row = {
    title: body.title,
    description: body.description || null,
    priority: body.priority || 'med',
    status: body.status || 'open',
    source: body.source || 'manual',
    source_message_id: body.source_message_id || null,
    due_at: body.due_at || null,
    workspace_id: body.workspace_id || null,
    list_id: body.list_id || null,
    creator_user_id: req.auth.userId,
    assignee_user_id: body.assignee_user_id || req.auth.userId,
  };
  if (row.workspace_id) {
    const { data: me } = await supabase.from('workspace_members')
      .select('role').eq('workspace_id', row.workspace_id).eq('user_id', req.auth.userId)
      .is('left_at', null).maybeSingle();
    if (!me) return forbidden(res, 'Not a workspace member');
  }
  const { data, error } = await supabase.from('tasks').insert(row).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  // Checklist items
  if (Array.isArray(body.checklist) && body.checklist.length) {
    const items = body.checklist.map((c, i) => ({
      task_id: data.id, text: c.text, done: !!c.done, position: i,
    }));
    await supabase.from('task_checklist_items').insert(items);
  }

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: row.workspace_id,
    action: 'task.create', targetType: 'task', targetId: data.id, req });
  try {
    require('../webhooks/dispatcher').emit({
      event: 'task.created', workspaceId: row.workspace_id || null, payload: { task: data },
    });
  } catch { /* swallow */ }
  created(res, { task: data });
}

async function update(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const { data: task } = await supabase.from('tasks').select('*').eq('id', params.id).maybeSingle();
  if (!task || task.deleted_at) return notFound(res);

  let allowed = task.creator_user_id === req.auth.userId || task.assignee_user_id === req.auth.userId;
  if (!allowed && task.workspace_id) {
    const { data: me } = await supabase.from('workspace_members').select('role')
      .eq('workspace_id', task.workspace_id).eq('user_id', req.auth.userId)
      .is('left_at', null).maybeSingle();
    allowed = me && ['owner', 'admin'].includes(me.role);
  }
  if (!allowed) return forbidden(res);

  const patch = {};
  for (const k of ['title', 'description', 'priority', 'status', 'due_at', 'assignee_user_id', 'list_id']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (patch.status === 'done' && !task.completed_at) {
    patch.completed_at = new Date().toISOString();
    patch.completed_by_user_id = req.auth.userId;
  }
  if (patch.status && patch.status !== 'done') {
    patch.completed_at = null;
    patch.completed_by_user_id = null;
  }

  const { data, error } = await supabase.from('tasks').update(patch).eq('id', params.id)
    .select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: task.workspace_id,
    action: 'task.update', targetType: 'task', targetId: params.id, metadata: patch, req });
  try {
    const event = patch.status === 'done' ? 'task.completed' : 'task.updated';
    require('../webhooks/dispatcher').emit({
      event, workspaceId: task.workspace_id || null, payload: { task: data, patch },
    });
  } catch { /* swallow */ }
  ok(res, { task: data });
}

async function destroy(req, res, { params }) {
  const { data: task } = await supabase.from('tasks').select('*').eq('id', params.id).maybeSingle();
  if (!task) return notFound(res);
  if (task.creator_user_id !== req.auth.userId) return forbidden(res);
  await supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', params.id);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: task.workspace_id,
    action: 'task.delete', targetType: 'task', targetId: params.id, req });
  ok(res, { ok: true });
}

async function listLists(req, res, { query }) {
  let q = supabase.from('task_lists').select('*').is('deleted_at', null);
  if (query.workspace_id) q = q.eq('workspace_id', query.workspace_id);
  else q = q.eq('owner_user_id', req.auth.userId);
  const { data } = await q.order('position');
  ok(res, { lists: data || [] });
}

async function createList(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.name) return badRequest(res, 'name required');
  const { data, error } = await supabase.from('task_lists').insert({
    name: body.name,
    workspace_id: body.workspace_id || null,
    owner_user_id: body.workspace_id ? null : req.auth.userId,
    position: body.position || 0,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);
  created(res, { list: data });
}

module.exports = { list, create, update, destroy, listLists, createList };
