const { sendJSON, sendError } = require('../utils/response');
const supabase = require('../db/supabase');

async function handleSearchUsers(req, res, queryUrl) {
  const url = new URL(queryUrl, `http://${req.headers.host}`);
  const q = url.searchParams.get('q');
  
  if (!q) return sendJSON(res, 200, []);

  const searchUsername = q.startsWith('@') ? q.slice(1).toLowerCase() : q.toLowerCase();

  let query = supabase
    .from('users')
    .select('id, username, display_name, avatar_url, public_key')
    .limit(20);

  if (q.startsWith('+') || !isNaN(q[0])) {
    // Phone search setup
    const phoneSearch = q.startsWith('+') ? q : `+${q}`;
    query = query.ilike('phone_number', `%${phoneSearch}%`);
  } else {
    // Username / Display Name search
    query = query.or(`username.ilike.%${searchUsername}%,display_name.ilike.%${searchUsername}%`);
  }

  const { data: users, error } = await query;

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, users);
}

async function handleGetProfile(req, res, id) {
  const { data: user, error } = await supabase
    .from('users')
    .select('id, username, display_name, avatar_url, public_key, is_online, last_seen')
    .eq('id', id)
    .single();

  if (error) return sendError(res, 404, 'User not found');
  sendJSON(res, 200, user);
}

async function handleUpdateProfile(req, res, body) {
  const { displayName, username, avatarUrl, publicKey } = body;
  
  if (!displayName && !username && !avatarUrl && !publicKey) {
    return sendError(res, 400, "Nothing to update");
  }

  const updates = {};
  if (displayName !== undefined) updates.display_name = displayName;
  if (username !== undefined) updates.username = username;
  if (avatarUrl !== undefined) updates.avatar_url = avatarUrl;
  if (publicKey !== undefined) updates.public_key = publicKey;
  
  const { data: updatedUser, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', req.user.userId)
    .select('id, phone_number, display_name, username, account_type, avatar_url, public_key, is_online, last_seen')
    .single();

  if (error) {
    if (error.code === '23505') return sendError(res, 409, 'Username already exists');
    return sendError(res, 500, error.message);
  }

  sendJSON(res, 200, {
    id: updatedUser.id,
    phone: updatedUser.phone_number,
    displayName: updatedUser.display_name,
    username: updatedUser.username,
    accountType: updatedUser.account_type,
    avatarUrl: updatedUser.avatar_url,
    publicKey: updatedUser.public_key
  });
}

const SETTINGS_DEFAULTS = {
  show_online_status: true,
  show_last_seen: true,
  show_read_receipts: true,
  show_profile_photo: 'everyone',
  push_notifications: true,
  message_sound: true,
  group_notifications: true,
  show_preview: true,
  theme: 'system',
  font_size: 'medium',
  chat_bubble_style: 'modern',
};

async function handleGetSettings(req, res) {
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', req.user.userId)
    .maybeSingle();

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, data || { user_id: req.user.userId, ...SETTINGS_DEFAULTS });
}

async function handleUpdateSettings(req, res, body) {
  const allowed = Object.keys(SETTINGS_DEFAULTS);
  const updates = {};
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }
  if (Object.keys(updates).length === 0) return sendError(res, 400, 'Nothing to update');

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('user_settings')
    .upsert({ user_id: req.user.userId, ...updates }, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, data);
}

async function handleListBlockedUsers(req, res) {
  const { data, error } = await supabase
    .from('blocked_users')
    .select('id, blocked_id, created_at, users!blocked_users_blocked_id_fkey(id, username, display_name, avatar_url)')
    .eq('blocker_id', req.user.userId)
    .order('created_at', { ascending: false });

  if (error) return sendError(res, 500, error.message);
  const result = (data || []).map(b => ({
    id: b.id,
    blockedAt: b.created_at,
    user: b.users,
  }));
  sendJSON(res, 200, result);
}

async function handleBlockUser(req, res, body) {
  const { blocked_id } = body;
  if (!blocked_id) return sendError(res, 400, 'blocked_id is required');
  if (blocked_id === req.user.userId) return sendError(res, 400, 'Cannot block yourself');

  const { error } = await supabase
    .from('blocked_users')
    .insert({ blocker_id: req.user.userId, blocked_id });

  if (error) {
    if (error.code === '23505') return sendJSON(res, 200, { success: true }); // already blocked
    return sendError(res, 500, error.message);
  }
  sendJSON(res, 201, { success: true });
}

async function handleUnblockUser(req, res, userId) {
  const { error } = await supabase
    .from('blocked_users')
    .delete()
    .eq('blocker_id', req.user.userId)
    .eq('blocked_id', userId);

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, { success: true });
}

module.exports = {
  handleSearchUsers,
  handleGetProfile,
  handleUpdateProfile,
  handleGetSettings,
  handleUpdateSettings,
  handleListBlockedUsers,
  handleBlockUser,
  handleUnblockUser
};
