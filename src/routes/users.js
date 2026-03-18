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
  handleBlockUser,
  handleUnblockUser
};
