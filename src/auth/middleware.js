'use strict';

const { verifyAccess } = require('./jwt');
const { supabase } = require('../db/supabase');
const { unauthorized } = require('../util/response');

/**
 * Extract Bearer token, verify, load fresh device state.
 * On success sets req.auth = { userId, deviceId, device }.
 * Returns true if authed; false (and sends 401) otherwise.
 */
async function authenticate(req, res) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) { unauthorized(res); return false; }

  let claims;
  try { claims = verifyAccess(m[1]); }
  catch { unauthorized(res, 'Invalid token'); return false; }

  console.log('[Auth] Token verified for deviceId:', claims.deviceId);

  // Refuse if device was revoked
  console.time('[Auth] Device lookup');
  const { data: device, error } = await supabase
    .from('devices')
    .select('id, user_id, kind, revoked_at')
    .eq('id', claims.deviceId)
    .maybeSingle();
  console.timeEnd('[Auth] Device lookup');

  if (error) {
    console.error('[Auth] Device lookup error:', error);
    unauthorized(res, 'Database error');
    return false;
  }

  if (!device || device.revoked_at || device.user_id !== claims.userId) {
    unauthorized(res, 'Device revoked');
    return false;
  }

  console.log('[Auth] Device verified:', device.id);

  // Update last_seen (fire and forget)
  supabase.from('devices').update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id).then(() => {}, () => {});

  req.auth = { userId: claims.userId, deviceId: claims.deviceId, device };
  return true;
}

module.exports = { authenticate };
