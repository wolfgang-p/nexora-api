'use strict';

const { supabase } = require('../db/supabase');
const { sha256 } = require('../util/crypto');
const { unauthorized } = require('../util/response');

/**
 * Alternative auth path for CRM / server-to-server integrations.
 *
 * Header:  Authorization: Bearer koro_live_<secret>
 *
 * On success sets req.apiKey = { id, workspace_id, scopes, crm_device_id }.
 * If `require` is true, sends 401 on failure; otherwise silently returns false
 * so the normal Bearer-JWT flow can still match.
 */
async function authenticateApiKey(req, res, { require: requireIt = true } = {}) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(koro_(?:live|test)_[A-Za-z0-9_-]+)$/);
  if (!m) {
    if (requireIt) { unauthorized(res); return false; }
    return false;
  }
  const full = m[1];
  const hash = sha256(full);
  const { data: key } = await supabase
    .from('api_keys')
    .select('id, workspace_id, scopes, crm_device_id, revoked_at, expires_at')
    .eq('key_hash', hash)
    .maybeSingle();

  if (!key || key.revoked_at || (key.expires_at && new Date(key.expires_at) < new Date())) {
    if (requireIt) { unauthorized(res, 'Invalid API key'); return false; }
    return false;
  }
  supabase.from('api_keys').update({ last_used_at: new Date().toISOString() })
    .eq('id', key.id).then(() => {}, () => {});

  req.apiKey = key;
  return true;
}

/** Helper to check a scope like 'messages:read'. */
function hasScope(req, scope) {
  const scopes = req.apiKey?.scopes || [];
  return scopes.includes(scope) || scopes.includes('*');
}

module.exports = { authenticateApiKey, hasScope };
