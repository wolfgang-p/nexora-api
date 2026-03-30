const { sendJSON, sendError } = require('../utils/response');
const supabase = require('../db/supabase');
const { getConnection } = require('../ws/connections');

// Helper: get the current user's role in a conversation
async function getUserRole(conversationId, userId) {
  const { data } = await supabase
    .from('conversation_participants')
    .select('role')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .single();
  return data?.role || null;
}

// Helper: check if user is admin or owner
function isAdminOrOwner(role) {
  return role === 'admin' || role === 'owner';
}

// Helper: broadcast to all group participants via WS
async function broadcastToGroup(conversationId, senderId, payload) {
  const { data } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .is('deleted_at', null);

  if (!data) return;
  for (const p of data) {
    if (p.user_id === senderId) continue;
    const ws = getConnection(p.user_id);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }
}

// GET /conversations/:id/info
async function handleGetGroupInfo(req, res, conversationId) {
  const role = await getUserRole(conversationId, req.user.userId);
  if (!role) return sendError(res, 403, 'Not a participant');

  const { data: conv, error } = await supabase
    .from('conversations')
    .select('id, type, name, avatar_url, created_at, created_by, only_admins_send, only_admins_edit_info')
    .eq('id', conversationId)
    .single();

  if (error || !conv) return sendError(res, 404, 'Conversation not found');

  const { data: participants } = await supabase
    .from('conversation_participants')
    .select(`
      user_id, role, joined_at,
      users (id, username, display_name, avatar_url, is_online, public_key)
    `)
    .eq('conversation_id', conversationId)
    .is('deleted_at', null);

  sendJSON(res, 200, {
    ...conv,
    myRole: role,
    participants: (participants || []).map(p => ({
      ...p.users,
      role: p.role,
      joinedAt: p.joined_at,
    })),
  });
}

// PUT /conversations/:id — update group name/avatar
async function handleUpdateGroup(req, res, conversationId, body) {
  const role = await getUserRole(conversationId, req.user.userId);
  if (!role) return sendError(res, 403, 'Not a participant');

  // Check only_admins_edit_info setting
  const { data: conv } = await supabase
    .from('conversations')
    .select('only_admins_edit_info, type')
    .eq('id', conversationId)
    .single();

  if (!conv || conv.type !== 'group') return sendError(res, 400, 'Not a group conversation');

  if (conv.only_admins_edit_info && !isAdminOrOwner(role)) {
    return sendError(res, 403, 'Only admins can edit group info');
  }

  const updates = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.avatarUrl !== undefined) updates.avatar_url = body.avatarUrl;

  if (Object.keys(updates).length === 0) {
    return sendError(res, 400, 'No fields to update');
  }

  const { error } = await supabase
    .from('conversations')
    .update(updates)
    .eq('id', conversationId);

  if (error) return sendError(res, 500, error.message);

  await broadcastToGroup(conversationId, req.user.userId, {
    type: 'GROUP_UPDATED',
    conversationId,
    updates,
    updatedBy: req.user.userId,
  });

  sendJSON(res, 200, { success: true });
}

// POST /conversations/:id/participants — add members
async function handleAddMembers(req, res, conversationId, body) {
  const role = await getUserRole(conversationId, req.user.userId);
  if (!role) return sendError(res, 403, 'Not a participant');
  if (!isAdminOrOwner(role)) return sendError(res, 403, 'Only admins can add members');

  const { userIds } = body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return sendError(res, 400, 'userIds array required');
  }

  // Check which users are already participants
  const { data: existing } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .in('user_id', userIds)
    .is('deleted_at', null);

  const existingIds = new Set((existing || []).map(p => p.user_id));
  const newUserIds = userIds.filter(id => !existingIds.has(id));

  if (newUserIds.length === 0) {
    return sendError(res, 400, 'All users are already members');
  }

  // Verify users exist
  const { data: users } = await supabase
    .from('users')
    .select('id, username, display_name, avatar_url')
    .in('id', newUserIds);

  if (!users || users.length === 0) {
    return sendError(res, 404, 'No valid users found');
  }

  const inserts = users.map(u => ({
    conversation_id: conversationId,
    user_id: u.id,
    role: 'member',
  }));

  const { error } = await supabase
    .from('conversation_participants')
    .insert(inserts);

  if (error) return sendError(res, 500, error.message);

  // Broadcast to existing members
  for (const u of users) {
    await broadcastToGroup(conversationId, null, {
      type: 'GROUP_MEMBER_ADDED',
      conversationId,
      user: u,
      addedBy: req.user.userId,
    });
  }

  sendJSON(res, 200, { success: true, added: users.map(u => u.id) });
}

// DELETE /conversations/:id/participants/:userId — remove member
async function handleRemoveMember(req, res, conversationId, targetUserId) {
  const role = await getUserRole(conversationId, req.user.userId);
  if (!role) return sendError(res, 403, 'Not a participant');
  if (!isAdminOrOwner(role)) return sendError(res, 403, 'Only admins can remove members');

  // Can't remove the owner
  const targetRole = await getUserRole(conversationId, targetUserId);
  if (!targetRole) return sendError(res, 404, 'User is not a member');
  if (targetRole === 'owner') return sendError(res, 403, 'Cannot remove the group owner');
  // Admins can't remove other admins (only owner can)
  if (targetRole === 'admin' && role !== 'owner') {
    return sendError(res, 403, 'Only the owner can remove admins');
  }

  const { error } = await supabase
    .from('conversation_participants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('user_id', targetUserId);

  if (error) return sendError(res, 500, error.message);

  await broadcastToGroup(conversationId, null, {
    type: 'GROUP_MEMBER_REMOVED',
    conversationId,
    removedUserId: targetUserId,
    removedBy: req.user.userId,
  });

  sendJSON(res, 200, { success: true });
}

// PUT /conversations/:id/participants/:userId/role — change role
async function handleChangeRole(req, res, conversationId, targetUserId, body) {
  const role = await getUserRole(conversationId, req.user.userId);
  if (!role) return sendError(res, 403, 'Not a participant');
  if (role !== 'owner') return sendError(res, 403, 'Only the owner can change roles');

  const { newRole } = body;
  if (!['admin', 'member'].includes(newRole)) {
    return sendError(res, 400, 'newRole must be "admin" or "member"');
  }

  const targetRole = await getUserRole(conversationId, targetUserId);
  if (!targetRole) return sendError(res, 404, 'User is not a member');
  if (targetUserId === req.user.userId) return sendError(res, 400, 'Cannot change your own role');

  const { error } = await supabase
    .from('conversation_participants')
    .update({ role: newRole })
    .eq('conversation_id', conversationId)
    .eq('user_id', targetUserId);

  if (error) return sendError(res, 500, error.message);

  await broadcastToGroup(conversationId, null, {
    type: 'GROUP_ROLE_CHANGED',
    conversationId,
    userId: targetUserId,
    newRole,
    changedBy: req.user.userId,
  });

  sendJSON(res, 200, { success: true });
}

// PUT /conversations/:id/settings — update group settings
async function handleUpdateGroupSettings(req, res, conversationId, body) {
  const role = await getUserRole(conversationId, req.user.userId);
  if (!role) return sendError(res, 403, 'Not a participant');
  if (!isAdminOrOwner(role)) return sendError(res, 403, 'Only admins can change group settings');

  const updates = {};
  if (body.onlyAdminsSend !== undefined) updates.only_admins_send = body.onlyAdminsSend;
  if (body.onlyAdminsEditInfo !== undefined) updates.only_admins_edit_info = body.onlyAdminsEditInfo;

  if (Object.keys(updates).length === 0) {
    return sendError(res, 400, 'No settings to update');
  }

  const { error } = await supabase
    .from('conversations')
    .update(updates)
    .eq('id', conversationId);

  if (error) return sendError(res, 500, error.message);

  await broadcastToGroup(conversationId, req.user.userId, {
    type: 'GROUP_SETTINGS_CHANGED',
    conversationId,
    settings: updates,
    changedBy: req.user.userId,
  });

  sendJSON(res, 200, { success: true });
}

// POST /conversations/:id/leave — leave group
async function handleLeaveGroup(req, res, conversationId) {
  const role = await getUserRole(conversationId, req.user.userId);
  if (!role) return sendError(res, 403, 'Not a participant');

  // If owner is leaving, transfer ownership to first admin or first member
  if (role === 'owner') {
    const { data: others } = await supabase
      .from('conversation_participants')
      .select('user_id, role')
      .eq('conversation_id', conversationId)
      .neq('user_id', req.user.userId)
      .is('deleted_at', null)
      .order('role', { ascending: true }); // 'admin' comes before 'member' alphabetically

    if (others && others.length > 0) {
      // Pick first admin, or first member
      const newOwner = others.find(o => o.role === 'admin') || others[0];
      await supabase
        .from('conversation_participants')
        .update({ role: 'owner' })
        .eq('conversation_id', conversationId)
        .eq('user_id', newOwner.user_id);

      await broadcastToGroup(conversationId, req.user.userId, {
        type: 'GROUP_ROLE_CHANGED',
        conversationId,
        userId: newOwner.user_id,
        newRole: 'owner',
        changedBy: 'system',
      });
    }
  }

  const { error } = await supabase
    .from('conversation_participants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('user_id', req.user.userId);

  if (error) return sendError(res, 500, error.message);

  await broadcastToGroup(conversationId, req.user.userId, {
    type: 'GROUP_MEMBER_REMOVED',
    conversationId,
    removedUserId: req.user.userId,
    removedBy: req.user.userId,
  });

  sendJSON(res, 200, { success: true });
}

module.exports = {
  handleGetGroupInfo,
  handleUpdateGroup,
  handleAddMembers,
  handleRemoveMember,
  handleChangeRole,
  handleUpdateGroupSettings,
  handleLeaveGroup,
};
