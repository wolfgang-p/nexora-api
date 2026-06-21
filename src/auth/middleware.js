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
    // For a "Login with Koro" OAuth token: the granted scopes (array) and the
    // developer app id. null for a normal first-party (full-access) session.
    scopes: claims.scopes,
    oauthClientId: claims.clientId,
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

/**
 * Optional auth — populates req.auth if a valid Bearer token is
 * present, otherwise leaves req.auth = null and lets the request
 * through. Used by koro-meet endpoints that accept both Koro users
 * and anonymous guests.
 */
async function optionalAuthenticate(req) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) { req.auth = null; return; }
  // A Koro API key (e.g. a bot) authenticates here too: delegate to the
  // api-key middleware, which sets req.auth via the bot-device bridge when the
  // key is bound to one. Lazy require avoids any module load-order cycle.
  if (/^koro_(?:live|test)_/.test(m[1])) {
    req.auth = null;
    try {
      const { authenticateApiKey } = require('../api_keys/middleware');
      // Pass a no-op res — `require:false` means it never writes a response.
      await authenticateApiKey(req, { writeHead() {}, end() {}, setHeader() {} }, { require: false });
    } catch { /* leave req.auth null on any failure */ }
    return;
  }
  try {
    const claims = verifyAccess(m[1]);
    const { data: device } = await supabase.from('devices')
      .select('id, user_id, kind, revoked_at, users:user_id (id, is_admin, banned_at, deleted_at)')
      .eq('id', claims.deviceId).maybeSingle();
    if (!device || device.revoked_at || device.user_id !== claims.userId) {
      req.auth = null; return;
    }
    const user = Array.isArray(device.users) ? device.users[0] : device.users;
    if (!user || user.deleted_at || user.banned_at) { req.auth = null; return; }
    req.auth = {
      userId: claims.userId,
      deviceId: claims.deviceId,
      device: { id: device.id, user_id: device.user_id, kind: device.kind, revoked_at: device.revoked_at },
      user: { id: user.id, is_admin: !!user.is_admin, banned_at: user.banned_at },
      scopes: claims.scopes,
      oauthClientId: claims.clientId,
    };
  } catch { req.auth = null; }
}

/**
 * Enforce that the current request carries an OAuth scope (when it's an OAuth
 * token). MUST be called after authenticate()/dualAuth populated req.auth.
 *
 *  - First-party session token (req.auth.scopes == null): full access → allow.
 *  - API-key/bot (req.auth.viaApiKey): governed by api-key scopes elsewhere → allow.
 *  - OAuth token: allow only if the scope (or '*') was granted.
 *
 * Returns true if allowed; sends 403 and returns false otherwise.
 */
function requireOAuthScope(req, res, scope) {
  const scopes = req.auth?.scopes;
  // Not an OAuth token (first-party or bot) — scope gate doesn't apply.
  if (scopes == null) return true;
  if (scopes.includes('*') || scopes.includes(scope)) return true;
  forbidden(res, `Missing scope: ${scope}`);
  return false;
}

module.exports = { authenticate, requireAdmin, optionalAuthenticate, requireOAuthScope };
