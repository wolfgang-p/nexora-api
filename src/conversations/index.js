'use strict';

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { emitSystemMessage, fetchLabel, fetchLabels } = require('../util/systemMessage');

/**
 * GET /conversations
 * Returns: list of conversations the current user is in, with last message envelope.
 */
async function listConversations(req, res) {
  const { data: memberships } = await supabase
    .from('conversation_members')
    .select(`
      conversation_id, role, notif_level, muted_until, pinned_at, archived_at,
      auto_translate_override,
      last_read_message_id, last_read_at,
      conversation:conversations!inner(id, kind, workspace_id, title, avatar_url, only_admins_send, message_ttl_seconds, created_at, updated_at, deleted_at)
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
      .from('messages').select('id, conversation_id, kind, created_at, sender_user_id, sender_device_id')
      .in('conversation_id', convIds)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    for (const m of msgs || []) {
      if (!latestByConv.has(m.conversation_id)) latestByConv.set(m.conversation_id, m);
    }
  }

  // Pull THIS device's recipient copies for those latest messages so the
  // client can decrypt the preview locally on first load — no need to
  // open every chat individually to get "Letzte Nachricht: …".
  let cipherByMsgId = new Map();
  const latestMsgIds = Array.from(latestByConv.values()).map((m) => m.id);
  if (latestMsgIds.length > 0) {
    const { data: copies } = await supabase
      .from('message_recipients')
      .select('message_id, ciphertext, nonce')
      .in('message_id', latestMsgIds)
      .eq('recipient_device_id', req.auth.deviceId);
    for (const c of copies || []) cipherByMsgId.set(c.message_id, c);
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
    .map((m) => {
      const last = latestByConv.get(m.conversation_id) || null;
      const cipher = last ? cipherByMsgId.get(last.id) : null;
      return {
        ...m.conversation,
        my_role: m.role,
        notif_level: m.notif_level,
        muted_until: m.muted_until,
        pinned_at: m.pinned_at,
        archived_at: m.archived_at,
        auto_translate_override: m.auto_translate_override,
        last_read_message_id: m.last_read_message_id,
        last_read_at: m.last_read_at,
        last_message: last,
        last_message_ciphertext: cipher?.ciphertext || null,
        last_message_nonce: cipher?.nonce || null,
        peer: peerByConv.get(m.conversation_id) || null,
      };
    });

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

  if (kind === 'group') {
    const actor = await fetchLabel(req.auth.userId);
    emitSystemMessage({
      conversationId: conv.id,
      actorUserId: req.auth.userId,
      actorDeviceId: req.auth.deviceId,
      payload: { action: 'group_created', actor },
    }).catch(() => {});
  }

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
    // Disappearing messages — null disables TTL, otherwise the value is
    // the lifetime in seconds. Cap at 30d so admins can't accidentally
    // pin "delete after 1 year" semantics that look broken to users.
    if (body.message_ttl_seconds !== undefined) {
      const v = body.message_ttl_seconds;
      patch.message_ttl_seconds = v == null ? null : Math.max(60, Math.min(60 * 60 * 24 * 30, Number(v) || 0));
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

  // System messages for visible changes (group/channel only — direct chats
  // don't have a title anyway)
  if (conv.kind !== 'direct') {
    const actor = await fetchLabel(req.auth.userId);
    if (patch.title !== undefined && patch.title !== conv.title) {
      emitSystemMessage({
        conversationId: params.id, actorUserId: req.auth.userId, actorDeviceId: req.auth.deviceId,
        payload: { action: 'group_renamed', actor, new_title: patch.title },
      }).catch(() => {});
    }
    if (patch.avatar_url !== undefined && patch.avatar_url !== conv.avatar_url) {
      emitSystemMessage({
        conversationId: params.id, actorUserId: req.auth.userId, actorDeviceId: req.auth.deviceId,
        payload: { action: 'group_avatar_changed', actor },
      }).catch(() => {});
    }
  }

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

  const [actor, targets] = await Promise.all([
    fetchLabel(req.auth.userId),
    fetchLabels(body.user_ids),
  ]);
  emitSystemMessage({
    conversationId: params.id,
    actorUserId: req.auth.userId,
    actorDeviceId: req.auth.deviceId,
    payload: { action: 'member_added', actor, targets },
  }).catch(() => {});

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

  const [actor, target] = await Promise.all([
    fetchLabel(req.auth.userId),
    fetchLabel(params.userId),
  ]);
  emitSystemMessage({
    conversationId: params.id,
    actorUserId: req.auth.userId,
    actorDeviceId: req.auth.deviceId,
    payload: selfLeave
      ? { action: 'member_left', actor }
      : { action: 'member_removed', actor, target },
  }).catch(() => {});

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

  const [actor, target] = await Promise.all([
    fetchLabel(req.auth.userId),
    fetchLabel(params.userId),
  ]);
  emitSystemMessage({
    conversationId: params.id,
    actorUserId: req.auth.userId,
    actorDeviceId: req.auth.deviceId,
    payload: { action: 'role_changed', actor, target, role: body.role },
  }).catch(() => {});

  ok(res, { ok: true });
}

/**
 * GET /conversations/:id/info
 * Returns full conversation + member list (with display_name, avatar_url, role).
 */
async function getConversationInfo(req, res, { params }) {
  const { data: conv } = await supabase
    .from('conversations').select('*').eq('id', params.id).maybeSingle();
  if (!conv || conv.deleted_at) return notFound(res, 'Conversation not found');

  const { data: me } = await supabase.from('conversation_members')
    .select('role')
    .eq('conversation_id', params.id)
    .eq('user_id', req.auth.userId)
    .is('left_at', null)
    .maybeSingle();
  if (!me) return forbidden(res, 'Not a member');

  const { data: rows } = await supabase
    .from('conversation_members')
    .select('user_id, role, joined_at, user:users!inner(id, username, display_name, avatar_url, last_seen_at)')
    .eq('conversation_id', params.id)
    .is('left_at', null);

  const members = (rows || []).map((r) => ({
    id: r.user?.id,
    username: r.user?.username ?? null,
    display_name: r.user?.display_name ?? null,
    avatar_url: r.user?.avatar_url ?? null,
    last_seen_at: r.user?.last_seen_at ?? null,
    role: r.role,
    joined_at: r.joined_at,
  }));

  ok(res, {
    conversation: { ...conv, my_role: me.role },
    members,
  });
}

/**
 * PUT /conversations/:id/notification-level
 * Body: { level: 'all' | 'mentions' | 'muted' }
 * Per-user setting on conversation_members.
 */
async function setNotificationLevel(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  const lvl = body?.level;
  if (!['all', 'mentions', 'muted'].includes(lvl)) return badRequest(res, 'level required');
  const { error } = await supabase.from('conversation_members')
    .update({ notif_level: lvl })
    .eq('conversation_id', params.id)
    .eq('user_id', req.auth.userId)
    .is('left_at', null);
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { ok: true });
}

/**
 * POST /conversations/:id/archive       — flip on
 * DELETE /conversations/:id/archive     — flip off
 */
async function archive(req, res, { params }) {
  const at = req.method === 'DELETE' ? null : new Date().toISOString();
  await supabase.from('conversation_members')
    .update({ archived_at: at })
    .eq('conversation_id', params.id)
    .eq('user_id', req.auth.userId)
    .is('left_at', null);
  ok(res, { ok: true });
}

/**
 * PUT /conversations/:id/auto-translate
 * Body: { override: 'on' | 'off' | null }
 *
 * Per-user, per-conversation override of the user-level auto-translate
 * setting. Useful for "this one chat I want to read in the original
 * language" without losing global auto-translate.
 */
async function setAutoTranslateOverride(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  const v = body?.override;
  if (v !== null && v !== 'on' && v !== 'off') return badRequest(res, 'override must be on|off|null');
  const { error } = await supabase.from('conversation_members')
    .update({ auto_translate_override: v })
    .eq('conversation_id', params.id)
    .eq('user_id', req.auth.userId)
    .is('left_at', null);
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { ok: true });
}

module.exports = {
  listConversations, createConversation, updateConversation,
  addMembers, removeMember, changeRole, getConversationInfo,
  setNotificationLevel, archive, setAutoTranslateOverride,
};
