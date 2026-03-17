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

module.exports = {
  handleSearchUsers,
  handleGetProfile
};
