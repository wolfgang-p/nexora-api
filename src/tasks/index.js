'use strict';

const { supabase } = require('../db/supabase');
const { ok, created, badRequest, notFound, forbidden, readJson, serverError } = require('../util/response');
const { audit } = require('../util/audit');

async function list(req, res, { query }) {
  // Default scope: tasks I created OR I'm assigned to OR I'm a member of
  // the workspace they belong to. Without this the endpoint leaked
  // every task in the DB to every authed user — a peer's accepted AI
  // suggestion in a shared chat would show up in my Tasks tab.
  const me = req.auth.userId;

  // Pull the workspaces I belong to so we can include workspace-scoped
  // tasks I might not have created myself.
  const { data: myWorkspaceMemberships } = await supabase
    .from('workspace_members').select('workspace_id')
    .eq('user_id', me).is('left_at', null);
  const myWorkspaceIds = (myWorkspaceMemberships || []).map((m) => m.workspace_id);

  let q = supabase.from('tasks').select(`
    *,
    source_message:messages!tasks_source_message_id_fkey(id, conversation_id)
  `).is('deleted_at', null);

  // Build the OR-clause: creator or assignee or workspace-member.
  const orParts = [
    `creator_user_id.eq.${me}`,
    `assignee_user_id.eq.${me}`,
  ];
  if (myWorkspaceIds.length > 0) {
    orParts.push(`workspace_id.in.(${myWorkspaceIds.join(',')})`);
  }
  q = q.or(orParts.join(','));

  if (query.workspace_id) q = q.eq('workspace_id', query.workspace_id);
  if (query.assignee_id && query.assignee_id !== 'me') q = q.eq('assignee_user_id', query.assignee_id);
  if (query.status) q = q.eq('status', query.status);
  if (query.source) q = q.eq('source', query.source);
  if (query.mine === 'true' || query.assignee_id === 'me') {
    // Tighten the default scope to JUST creator/assignee (drop workspace).
    q = q.or(`creator_user_id.eq.${me},assignee_user_id.eq.${me}`);
  }
  q = q.order('created_at', { ascending: false }).limit(
    Math.min(Number(query.limit) || 100, 500),
  );
  const { data, error } = await q;
  if (error) return serverError(res, 'Query failed', error);
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
    parent_id: body.parent_id || null,
    recurrence: body.recurrence ? String(body.recurrence).slice(0, 500) : null,
    creator_user_id: req.auth.userId,
    assignee_user_id: body.assignee_user_id || req.auth.userId,
  };
  if (row.workspace_id) {
    const { data: me } = await supabase.from('workspace_members')
      .select('role').eq('workspace_id', row.workspace_id).eq('user_id', req.auth.userId)
      .is('left_at', null).maybeSingle();
    if (!me) return forbidden(res, 'Not a workspace member');
  }
  // If a chat-anchored task is created, verify the user is a member of
  // that conversation. Otherwise an attacker could spy on a chat by
  // creating a task and reading source_conversation_id back via list().
  if (row.source_message_id) {
    const { data: msg } = await supabase.from('messages')
      .select('conversation_id').eq('id', row.source_message_id).maybeSingle();
    if (msg?.conversation_id) {
      const { data: m } = await supabase.from('conversation_members')
        .select('user_id').eq('conversation_id', msg.conversation_id)
        .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
      if (!m) return forbidden(res, 'Not a member of source conversation');
    }
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
  for (const k of ['title', 'description', 'priority', 'status', 'due_at', 'assignee_user_id', 'list_id', 'parent_id', 'recurrence']) {
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

  // Spawn next instance for recurring tasks when this one is marked
  // done. We compute a simple next-due via DTSTART + rrule freq; the
  // server only handles common cases (DAILY / WEEKLY / MONTHLY /
  // YEARLY with INTERVAL=1). More complex RRULEs need a real lib.
  if (patch.status === 'done' && task.recurrence && task.due_at) {
    const next = nextOccurrence(new Date(task.due_at), task.recurrence);
    if (next) {
      await supabase.from('tasks').insert({
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: 'open',
        source: 'manual',
        due_at: next.toISOString(),
        workspace_id: task.workspace_id,
        list_id: task.list_id,
        parent_id: task.parent_id,
        recurrence: task.recurrence,
        creator_user_id: task.creator_user_id,
        assignee_user_id: task.assignee_user_id,
      });
    }
  }
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

/**
 * Compute the next occurrence of a recurring task. Supports the four
 * common RFC5545 frequencies (DAILY/WEEKLY/MONTHLY/YEARLY) with a
 * positive integer INTERVAL. Returns null for unsupported rules — the
 * caller treats that as "no next instance" and stops the chain.
 */
function nextOccurrence(from, rrule) {
  if (!from || !rrule) return null;
  const m = String(rrule).match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;INTERVAL=(\d+))?/i);
  if (!m) return null;
  const freq = m[1].toUpperCase();
  const interval = Math.max(1, Number(m[2]) || 1);
  const d = new Date(from.getTime());
  switch (freq) {
    case 'DAILY':   d.setDate(d.getDate() + interval); break;
    case 'WEEKLY':  d.setDate(d.getDate() + 7 * interval); break;
    case 'MONTHLY': d.setMonth(d.getMonth() + interval); break;
    case 'YEARLY':  d.setFullYear(d.getFullYear() + interval); break;
    default: return null;
  }
  // Stop after a year of generated instances even if the user spams
  // "Mark done" — defensive cap.
  if (d.getTime() - Date.now() > 5 * 365 * 86400_000) return null;
  return d;
}

// ── Time tracking ───────────────────────────────────────────────────────

/**
 * POST /tasks/:id/timer/start  → opens an entry (ended_at = null).
 * POST /tasks/:id/timer/stop   → closes the open entry; ignores if none.
 * GET  /tasks/:id/timer        → list entries + total seconds.
 */
async function startTimer(req, res, { params }) {
  const { data: task } = await supabase.from('tasks').select('id, deleted_at').eq('id', params.id).maybeSingle();
  if (!task || task.deleted_at) return notFound(res);

  // Clear any other open entries for this user (one-active-at-a-time).
  await supabase.from('task_time_entries')
    .update({ ended_at: new Date().toISOString() })
    .eq('user_id', req.auth.userId).is('ended_at', null);

  const { data, error } = await supabase.from('task_time_entries').insert({
    task_id: params.id,
    user_id: req.auth.userId,
    started_at: new Date().toISOString(),
    note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : null,
  }).select('*').single();
  if (error) return serverError(res, 'Start failed', error);
  ok(res, { entry: data });
}

async function stopTimer(req, res, { params }) {
  const { data, error } = await supabase.from('task_time_entries')
    .update({ ended_at: new Date().toISOString() })
    .eq('task_id', params.id).eq('user_id', req.auth.userId).is('ended_at', null)
    .select('*');
  if (error) return serverError(res, 'Stop failed', error);
  ok(res, { entries: data || [] });
}

async function listTimer(req, res, { params }) {
  const { data: entries } = await supabase.from('task_time_entries')
    .select('*').eq('task_id', params.id)
    .order('started_at', { ascending: false }).limit(200);
  let total = 0;
  for (const e of entries || []) {
    const start = new Date(e.started_at).getTime();
    const end = e.ended_at ? new Date(e.ended_at).getTime() : Date.now();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) total += end - start;
  }
  ok(res, { entries: entries || [], total_seconds: Math.round(total / 1000) });
}

module.exports = { list, create, update, destroy, listLists, createList, startTimer, stopTimer, listTimer };
