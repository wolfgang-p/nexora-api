const { sendJSON, sendError } = require('../utils/response');
const supabase = require('../db/supabase');

async function handleSearchUsers(req, res, queryUrl) {
  const url = new URL(queryUrl, `http://${req.headers.host}`);
  const q = url.searchParams.get('q');
  
  if (!q) return sendJSON(res, 200, []);

  const searchUsername = q.startsWith('@') ? q.slice(1).toLowerCase() : q.toLowerCase();

  const { data: users, error } = await supabase
    .from('users')
    .select('id, username, display_name, avatar_url, public_key')
    .ilike('username', `%${searchUsername}%`)
    .limit(20);

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

module.exports = {
  handleSearchUsers,
  handleGetProfile
};
