'use strict';

const { verifyAccess } = require('./jwt');
const { supabase } = require('../db/supabase');
const { unauthorized, forbidden } = require('../util/response');

/**
 * Extract Bearer token, verify, load fresh device state.
 * On success sets req.auth = { userId, deviceId, device, user: { is_admin, banned_at } }.
 * Returns true if authed; false (and sends 401/403) otherwise.
 */
async function authenticate(req, res) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) { unauthorized(res); return false; }

  let claims;
  try { claims = verifyAccess(m[1]); }
  catch { unauthorized(res, 'Invalid token'); return false; }

  // Refuse if device was revoked. Join user so we can also reject banned
  // users without a second round-trip.
  const { data: device, error } = await supabase
    .from('devices')
    .select('id, user_id, kind, revoked_at, users:user_id (id, is_admin, banned_at, deleted_at)')
    .eq('id', claims.deviceId)
    .maybeSingle();

  if (error) {
    console.error('[Auth] Device lookup error:', error);
    unauthorized(res, 'Database error');
    return false;
  }

  if (!device || device.revoked_at || device.user_id !== claims.userId) {
    unauthorized(res, 'Device revoked');
    return false;
  }

  const user = Array.isArray(device.users) ? device.users[0] : device.users;
  if (!user || user.deleted_at) {
    unauthorized(res, 'User not found');
    return false;
  }
  if (user.banned_at) {
    forbidden(res, 'Account banned');
    return false;
  }

  // Update last_seen (fire and forget)
  supabase.from('devices').update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id).then(() => {}, () => {});

  req.auth = {
    userId: claims.userId,
    deviceId: claims.deviceId,
    device: { id: device.id, user_id: device.user_id, kind: device.kind, revoked_at: device.revoked_at },
    user: { id: user.id, is_admin: !!user.is_admin, banned_at: user.banned_at },
  };
  return true;
}

/**
 * Gate for /admin/* endpoints. MUST be called after `authenticate()`.
 * Returns true if the user has is_admin=true, false (+ 403) otherwise.
 */
async function requireAdmin(req, res) {
  if (!req.auth) { unauthorized(res); return false; }
  if (!req.auth.user?.is_admin) {
    forbidden(res, 'Admin only');
    return false;
  }
  return true;
}

module.exports = { authenticate, requireAdmin };
