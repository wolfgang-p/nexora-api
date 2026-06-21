'use strict';

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { randomBase64Url, sha256 } = require('../util/crypto');
const { audit } = require('../util/audit');
const { sanitizeScopes, OAUTH_SCOPE_IDS } = require('./scopes');

// What we return to the portal — never the secret hash.
const CLIENT_COLS =
  'id, workspace_id, client_id, name, logo_url, homepage_url, redirect_uris, scopes, is_public, created_at, updated_at, revoked_at';

async function isWsAdmin(userId, workspaceId) {
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', userId).is('left_at', null).maybeSingle();
  return !!me && ['owner', 'admin'].includes(me.role);
}

function validRedirectUris(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const u of arr) {
    if (typeof u !== 'string' || !u.trim()) continue;
    let parsed;
    try { parsed = new URL(u.trim()); } catch { return null; }
    // Allow https everywhere; http only for localhost (dev).
    const isLocal = ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) return null;
    out.push(parsed.toString());
  }
  return out;
}

/**
 * GET /workspaces/:id/oauth-clients   (workspace admin)
 */
async function list(req, res, { params }) {
  if (!(await isWsAdmin(req.auth.userId, params.id))) return forbidden(res);
  const { data } = await supabase.from('oauth_clients')
    .select(CLIENT_COLS)
    .eq('workspace_id', params.id)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  ok(res, { clients: data || [] });
}

/**
 * POST /workspaces/:id/oauth-clients
 * Body: { name, logo_url?, homepage_url?, redirect_uris: [], scopes: [], is_public? }
 * Returns the client_secret ONCE (omitted for public/PKCE clients).
 */
async function create(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.name || typeof body.name !== 'string') return badRequest(res, 'name required');
  if (!(await isWsAdmin(req.auth.userId, params.id))) return forbidden(res);

  const redirectUris = validRedirectUris(body.redirect_uris || []);
  if (redirectUris === null) return badRequest(res, 'redirect_uris must be https (or http://localhost) URLs');
  const scopes = sanitizeScopes(body.scopes || [], OAUTH_SCOPE_IDS);
  if (!scopes.length) return badRequest(res, 'at least one valid scope required');

  const isPublic = body.is_public === true;
  const clientId = `koro_app_${randomBase64Url(8)}`;
  let secret = null;
  let secretHash = null;
  if (!isPublic) {
    secret = `koro_csk_${randomBase64Url(32)}`; // client secret key
    secretHash = sha256(secret);
  }

  const { data, error } = await supabase.from('oauth_clients').insert({
    workspace_id: params.id,
    client_id: clientId,
    client_secret_hash: secretHash,
    name: body.name.slice(0, 120),
    logo_url: body.logo_url || null,
    homepage_url: body.homepage_url || null,
    redirect_uris: redirectUris,
    scopes,
    is_public: isPublic,
    created_by_user: req.auth.userId,
  }).select(CLIENT_COLS).single();
  if (error) return serverError(res, 'Could not create OAuth app', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'oauth.client.create', targetType: 'oauth_client', targetId: data.id,
    metadata: { client_id: clientId, scopes, is_public: isPublic }, req,
  });

  created(res, { client: data, client_secret: secret });
}

/**
 * PUT /oauth-clients/:id   (workspace admin)
 * Body: { name?, logo_url?, homepage_url?, redirect_uris?, scopes? }
 */
async function update(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const { data: client } = await supabase.from('oauth_clients')
    .select('id, workspace_id').eq('id', params.id).maybeSingle();
  if (!client) return notFound(res, 'OAuth app not found');
  if (!(await isWsAdmin(req.auth.userId, client.workspace_id))) return forbidden(res);

  const patch = {};
  if (typeof body.name === 'string') patch.name = body.name.slice(0, 120);
  if ('logo_url' in body) patch.logo_url = body.logo_url || null;
  if ('homepage_url' in body) patch.homepage_url = body.homepage_url || null;
  if ('redirect_uris' in body) {
    const uris = validRedirectUris(body.redirect_uris || []);
    if (uris === null) return badRequest(res, 'redirect_uris must be https (or http://localhost) URLs');
    patch.redirect_uris = uris;
  }
  if ('scopes' in body) {
    const scopes = sanitizeScopes(body.scopes || [], OAUTH_SCOPE_IDS);
    if (!scopes.length) return badRequest(res, 'at least one valid scope required');
    patch.scopes = scopes;
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('oauth_clients')
    .update(patch).eq('id', params.id).select(CLIENT_COLS).single();
  if (error) return serverError(res, 'Could not update OAuth app', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: client.workspace_id,
    action: 'oauth.client.update', targetType: 'oauth_client', targetId: client.id, req,
  });
  ok(res, { client: data });
}

/**
 * POST /oauth-clients/:id/rotate-secret   (workspace admin)
 * Issues a fresh client_secret, returned ONCE. Old secret stops working.
 */
async function rotateSecret(req, res, { params }) {
  const { data: client } = await supabase.from('oauth_clients')
    .select('id, workspace_id, is_public').eq('id', params.id).maybeSingle();
  if (!client) return notFound(res, 'OAuth app not found');
  if (!(await isWsAdmin(req.auth.userId, client.workspace_id))) return forbidden(res);
  if (client.is_public) return badRequest(res, 'Public clients have no secret');

  const secret = `koro_csk_${randomBase64Url(32)}`;
  await supabase.from('oauth_clients')
    .update({ client_secret_hash: sha256(secret), updated_at: new Date().toISOString() })
    .eq('id', params.id);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: client.workspace_id,
    action: 'oauth.client.rotate_secret', targetType: 'oauth_client', targetId: client.id, req,
  });
  ok(res, { client_secret: secret });
}

/**
 * DELETE /oauth-clients/:id   (workspace admin)
 * Revokes the app and every token issued for it.
 */
async function revoke(req, res, { params }) {
  const { data: client } = await supabase.from('oauth_clients')
    .select('id, workspace_id, client_id').eq('id', params.id).maybeSingle();
  if (!client) return ok(res, { ok: true });
  if (!(await isWsAdmin(req.auth.userId, client.workspace_id))) return forbidden(res);

  const now = new Date().toISOString();
  await supabase.from('oauth_clients').update({ revoked_at: now }).eq('id', params.id);
  await supabase.from('oauth_tokens').update({ revoked_at: now })
    .eq('client_id', client.client_id).is('revoked_at', null);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: client.workspace_id,
    action: 'oauth.client.revoke', targetType: 'oauth_client', targetId: client.id, req,
  });
  ok(res, { ok: true });
}

module.exports = { list, create, update, rotateSecret, revoke };
