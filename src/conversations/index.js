'use strict';

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');

/**
 * GET /conversations
 * Returns: list of conversations the current user is in, with last message envelope.
 */
async function listConversations(req, res) {
  const { data: memberships } = await supabase
    .from('conversation_members')
    .select(`
      conversation_id, role, notif_level, muted_until, pinned_at, archived_at,
      last_read_message_id, last_read_at,
      conversation:conversations!inner(id, kind, workspace_id, title, avatar_url, only_admins_send, created_at, updated_at, deleted_at)
    `)
    .eq('user_id', req.auth.userId)
    .is('left_at', null);

  if (!memberships) return ok(res, { conversations: [] });

  const convIds = memberships
    .filter((m) => m.conversation && !m.conversation.deleted_at)
    .map((m) => m.conversation_id);

  // Latest message per conv
  let latestByConv = new Map();
  if (convIds.length > 0) {
    const { data: msgs } = await supabase
      .from('messages').select('id, conversation_id, kind, created_at, sender_user_id')
      .in('conversation_id', convIds)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    for (const m of msgs || []) {
      if (!latestByConv.has(m.conversation_id)) latestByConv.set(m.conversation_id, m);
    }
  }

  // For direct chats we need the peer's display name + avatar (so the UI can
  // show "Marlene" instead of a bare conversation row).
  let peerByConv = new Map();
  const directConvIds = memberships
    .filter((m) => m.conversation?.kind === 'direct' && !m.conversation.deleted_at)
    .map((m) => m.conversation_id);

  if (directConvIds.length > 0) {
    const { data: rows } = await supabase
      .from('conversation_members')
      .select('conversation_id, user_id, user:users!inner(id, username, display_name, avatar_url)')
      .in('conversation_id', directConvIds)
      .is('left_at', null)
      .neq('user_id', req.auth.userId);
    for (const r of rows || []) {
      if (r.user) peerByConv.set(r.conversation_id, r.user);
    }
  }

  const out = memberships
    .filter((m) => m.conversation && !m.conversation.deleted_at)
    .map((m) => ({
      ...m.conversation,
      my_role: m.role,
      notif_level: m.notif_level,
      muted_until: m.muted_until,
      pinned_at: m.pinned_at,
      archived_at: m.archived_at,
      last_read_message_id: m.last_read_message_id,
      last_read_at: m.last_read_at,
      last_message: latestByConv.get(m.conversation_id) || null,
      peer: peerByConv.get(m.conversation_id) || null,
    }));

  ok(res, { conversations: out });
}

/**
 * POST /conversations
 * Body: { kind: 'direct'|'group'|'channel', workspace_id?, title?, avatar_url?, member_user_ids: [] }
 */
async function createConversation(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const kind = body.kind;
  if (!['direct', 'group', 'channel'].includes(kind)) return badRequest(res, 'Invalid kind');
  const members = Array.isArray(body.member_user_ids) ? body.member_user_ids : [];
  if (!members.includes(req.auth.userId)) members.push(req.auth.userId);
  if (kind === 'direct' && members.length !== 2) {
    return badRequest(res, 'Direct conversation needs exactly 2 members');
  }

  const { data: conv, error } = await supabase.from('conversations').insert({
    kind,
    workspace_id: body.workspace_id || null,
    title: body.title || null,
    avatar_url: body.avatar_url || null,
    created_by: req.auth.userId,
  }).select('*').single();
  if (error) return serverError(res, 'Could not create conversation', error);

  const rows = members.map((uid, i) => ({
    conversation_id: conv.id,
    user_id: uid,
    role: uid === req.auth.userId ? (kind === 'group' || kind === 'channel' ? 'owner' : 'member') : 'member',
  }));
  const { error: memErr } = await supabase.from('conversation_members').insert(rows);
  if (memErr) {
    await supabase.from('conversations').delete().eq('id', conv.id);
    return serverError(res, 'Could not add members', memErr);
  }

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'conversation.create', targetType: 'conversation', targetId: conv.id, req });

  created(res, { conversation: conv });
}

/**
 * PUT /conversations/:id   admin-only for groups/channels
 * Body: { title?, avatar_url?, only_admins_send?, only_admins_edit_info? }
 */
async function updateConversation(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const { data: conv } = await supabase
    .from('conversations').select('*').eq('id', params.id).maybeSingle();
  if (!conv || conv.deleted_at) return notFound(res, 'Conversation not found');

  const { data: me } = await supabase
    .from('conversation_members')
    .select('role').eq('conversation_id', params.id)
    .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me) return forbidden(res, 'Not a member');
  const isAdmin = ['owner', 'admin'].includes(me.role);

  // only_admins_edit_info gate
  if (conv.only_admins_edit_info && !isAdmin) return forbidden(res, 'Only admins may edit info');

  const patch = {};
  for (const k of ['title', 'avatar_url', 'description']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (isAdmin) {
    for (const k of ['only_admins_send', 'only_admins_edit_info']) {
      if (body[k] !== undefined) patch[k] = Boolean(body[k]);
    }
  }
  if (Object.keys(patch).length === 0) return ok(res, { conversation: conv });

  const { data: updated, error } = await supabase
    .from('conversations').update(patch).eq('id', params.id)
    .select('*').single();
  if (error) return serverError(res, 'Update failed', error);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'conversation.update', targetType: 'conversation', targetId: params.id,
    metadata: patch, req });

  ok(res, { conversation: updated });
}

/**
 * POST /conversations/:id/members   { user_ids: [] }  admin-only
 */
async function addMembers(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.user_ids?.length) return badRequest(res, 'user_ids required');

  const { data: me } = await supabase
    .from('conversation_members').select('role')
    .eq('conversation_id', params.id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res, 'Admin only');

  const rows = body.user_ids.map((uid) => ({ conversation_id: params.id, user_id: uid, role: 'member' }));
  const { error } = await supabase.from('conversation_members').upsert(rows, {
    onConflict: 'conversation_id,user_id',
  });
  if (error) return serverError(res, 'Could not add members', error);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'conversation.members.add',
    targetType: 'conversation', targetId: params.id,
    metadata: { added: body.user_ids }, req });

  ok(res, { ok: true });
}

/**
 * DELETE /conversations/:id/members/:userId   admin-only (or self-leave)
 */
async function removeMember(req, res, { params }) {
  const selfLeave = params.userId === req.auth.userId;
  if (!selfLeave) {
    const { data: me } = await supabase
      .from('conversation_members').select('role')
      .eq('conversation_id', params.id).eq('user_id', req.auth.userId)
      .is('left_at', null).maybeSingle();
    if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res, 'Admin only');
  }
  await supabase.from('conversation_members').update({ left_at: new Date().toISOString() })
    .eq('conversation_id', params.id).eq('user_id', params.userId);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: selfLeave ? 'conversation.leave' : 'conversation.members.remove',
    targetType: 'conversation', targetId: params.id,
    metadata: { removed: params.userId }, req });

  ok(res, { ok: true });
}

/**
 * PUT /conversations/:id/members/:userId/role  { role }  owner only
 */
async function changeRole(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!['owner', 'admin', 'member'].includes(body?.role)) return badRequest(res, 'Invalid role');

  const { data: me } = await supabase
    .from('conversation_members').select('role')
    .eq('conversation_id', params.id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (me?.role !== 'owner') return forbidden(res, 'Owner only');

  const { error } = await supabase.from('conversation_members').update({ role: body.role })
    .eq('conversation_id', params.id).eq('user_id', params.userId);
  if (error) return serverError(res, 'Update failed', error);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'conversation.members.role',
    targetType: 'conversation', targetId: params.id,
    metadata: { target_user: params.userId, new_role: body.role }, req });

  ok(res, { ok: true });
}

module.exports = {
  listConversations, createConversation, updateConversation,
  addMembers, removeMember, changeRole,
};
