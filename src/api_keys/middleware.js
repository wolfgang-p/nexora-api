'use strict';

const { supabase } = require('../db/supabase');
const { sha256 } = require('../util/crypto');
const { unauthorized, forbidden } = require('../util/response');
const { hit, check, send429 } = require('../middleware/rateLimit');

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

  // Bridge to the normal auth context: a key bound to a bot device acts AS
  // that bot. Load the device + its user and populate req.auth so handlers
  // that stamp req.auth.userId / req.auth.deviceId (e.g. messages/send.js)
  // work unchanged. `viaApiKey` lets handlers branch (e.g. set sender_fallback).
  if (key.crm_device_id) {
    const { data: dev } = await supabase
      .from('devices')
      .select('id, user_id, revoked_at, user:user_id (id, display_name, username, is_bot)')
      .eq('id', key.crm_device_id)
      .maybeSingle();
    if (dev && !dev.revoked_at) {
      req.auth = {
        userId: dev.user_id,
        deviceId: dev.id,
        device: { id: dev.id, user_id: dev.user_id },
        user: dev.user || { id: dev.user_id },
        viaApiKey: true,
      };
    }
  }
  return true;
}

/** Helper to check a scope like 'messages:read'. */
function hasScope(req, scope) {
  const scopes = req.apiKey?.scopes || [];
  return scopes.includes(scope) || scopes.includes('*');
}

/**
 * Middleware factory. Usage in a handler gated by API key:
 *   if (!(await requireScope('messages:write')(req, res))) return;
 *
 * Also applies a per-scope, per-key sliding-ish rate-limit. The default
 * budget is generous (300 req/min) but adjustable via env:
 *   KORO_APIKEY_RL_<SCOPE_UPPER>=<limit>
 * e.g. KORO_APIKEY_RL_MESSAGES_WRITE=120
 */
const SCOPE_RL_DEFAULT = 300;
const SCOPE_RL_WINDOW_SEC = 60;

function requireScope(scope) {
  const envKey = `KORO_APIKEY_RL_${scope.replace(/[:.-]/g, '_').toUpperCase()}`;
  const limit = Number(process.env[envKey] || SCOPE_RL_DEFAULT);

  return async (req, res) => {
    if (!req.apiKey) { forbidden(res, 'API key required'); return false; }
    if (!hasScope(req, scope)) {
      forbidden(res, `Missing scope: ${scope}`);
      return false;
    }
    const bucket = `apiKey:${req.apiKey.id}:scope:${scope}`;
    if (!check(bucket, limit, SCOPE_RL_WINDOW_SEC)) {
      send429(res);
      return false;
    }
    hit(bucket);
    return true;
  };
}

/** All recognized scope names; used by the admin UI's scope-picker. */
const ALL_SCOPES = [
  'conversations:read', 'conversations:write',
  'messages:read',      'messages:write',
  'tasks:read',         'tasks:write',
  'users:read',
  'webhooks:manage',
];

module.exports = { authenticateApiKey, hasScope, requireScope, ALL_SCOPES };
