'use strict';

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, unauthorized, forbidden, serverError } = require('../util/response');
const { randomBase64Url, sha256, safeEqual } = require('../util/crypto');
const { signOAuthAccess } = require('../auth/jwt');
const { audit } = require('../util/audit');
const config = require('../config');

/** Verify a PKCE code_verifier against the stored challenge. */
function pkceOk(verifier, challenge, method) {
  if (!challenge) return true; // no PKCE in play
  if (!verifier) return false;
  if (method === 'plain') return safeEqual(verifier, challenge);
  // S256
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(hash, challenge);
}

/** Authenticate the calling client (confidential = secret, public = PKCE only). */
async function authClient(body) {
  const { data: client } = await supabase.from('oauth_clients')
    .select('client_id, client_secret_hash, is_public, revoked_at')
    .eq('client_id', body.client_id).maybeSingle();
  if (!client || client.revoked_at) return { error: 'unknown client' };
  if (!client.is_public) {
    if (!body.client_secret) return { error: 'client_secret required' };
    if (!safeEqual(sha256(body.client_secret), client.client_secret_hash || '')) {
      return { error: 'invalid client_secret' };
    }
  }
  return { client };
}

function issueTokens(grant, scopes) {
  const accessToken = signOAuthAccess({
    userId: grant.user_id,
    deviceId: grant.device_id,
    scopes,
    clientId: grant.client_id,
  });
  const refreshToken = randomBase64Url(48);
  return { accessToken, refreshToken, refreshHash: sha256(refreshToken) };
}

/**
 * POST /oauth/token   (no auth header — client authenticates in the body)
 *
 * Two grant types:
 *   grant_type=authorization_code
 *     Body: { client_id, client_secret?, code, code_verifier?, redirect_uri? }
 *     Exchanges a one-shot authorization code for access + refresh tokens.
 *   grant_type=refresh_token
 *     Body: { client_id, client_secret?, refresh_token }
 *     Rotates the refresh token and mints a fresh access token.
 *
 * Returns: { access_token, token_type, expires_in, refresh_token, scope,
 *            user, device_secret_ciphertext?, device_secret_nonce? }
 */
async function token(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.client_id) return badRequest(res, 'client_id required');

  const { client, error: clientErr } = await authClient(body);
  if (clientErr) return unauthorized(res, clientErr);

  if (body.grant_type === 'authorization_code') {
    return exchangeCode(req, res, body, client);
  }
  if (body.grant_type === 'refresh_token') {
    return refresh(req, res, body, client);
  }
  return badRequest(res, 'unsupported grant_type');
}

async function exchangeCode(req, res, body, client) {
  if (!body.code) return badRequest(res, 'code required');
  const codeHash = sha256(body.code);

  const { data: grant } = await supabase.from('oauth_grants')
    .select('*').eq('authorization_code_hash', codeHash).maybeSingle();
  if (!grant || grant.client_id !== client.client_id) return badRequest(res, 'invalid code');
  if (grant.status !== 'approved') return badRequest(res, 'grant not approved');
  if (grant.code_redeemed_at) return badRequest(res, 'code already redeemed');
  // Codes are valid only briefly after approval.
  const codeAgeMs = Date.now() - new Date(grant.approved_at).getTime();
  if (codeAgeMs > config.oauth.codeTtl * 1000) return badRequest(res, 'code expired');
  if (grant.redirect_uri && body.redirect_uri && grant.redirect_uri !== body.redirect_uri) {
    return badRequest(res, 'redirect_uri mismatch');
  }
  if (!pkceOk(body.code_verifier, grant.code_challenge, grant.code_challenge_method)) {
    return badRequest(res, 'PKCE verification failed');
  }

  const scopes = grant.granted_scopes || [];
  const { accessToken, refreshToken, refreshHash } = issueTokens(grant, scopes);
  const refreshExpires = new Date(Date.now() + config.oauth.refreshTtl * 1000).toISOString();

  // Record the token (one row per live refresh token) and burn the code.
  const { error: tokErr } = await supabase.from('oauth_tokens').insert({
    grant_id: grant.id,
    client_id: grant.client_id,
    user_id: grant.user_id,
    device_id: grant.device_id,
    scopes,
    refresh_token_hash: refreshHash,
    expires_at: refreshExpires,
  });
  if (tokErr) return serverError(res, 'Could not issue token', tokErr);

  await supabase.from('oauth_grants')
    .update({ status: 'consumed', code_redeemed_at: new Date().toISOString() })
    .eq('id', grant.id);

  const { data: user } = await supabase.from('users')
    .select('id, username, display_name, avatar_url')
    .eq('id', grant.user_id).maybeSingle();

  audit({
    userId: grant.user_id, deviceId: grant.device_id,
    action: 'oauth.token.issue', targetType: 'oauth_grant', targetId: grant.id,
    metadata: { client_id: grant.client_id, scopes }, req,
  });

  ok(res, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.oauth.accessTtl,
    refresh_token: refreshToken,
    scope: scopes.join(' '),
    user: user || null,
    // The user's sealed device secret (if the app supplied an ephemeral key at
    // authorize time) so the developer can derive the E2E secret to OPEN sealed
    // message copies addressed to the per-grant device.
    device_secret_ciphertext: grant.device_secret_ciphertext,
    device_secret_nonce: grant.device_secret_nonce,
    device_secret_sender_key: grant.device_secret_sender_key,
  });
}

async function refresh(req, res, body, client) {
  if (!body.refresh_token) return badRequest(res, 'refresh_token required');
  const hash = sha256(body.refresh_token);

  const { data: tok } = await supabase.from('oauth_tokens')
    .select('*').eq('refresh_token_hash', hash).maybeSingle();
  if (!tok || tok.client_id !== client.client_id) return unauthorized(res, 'invalid refresh_token');
  if (tok.revoked_at) return unauthorized(res, 'token revoked', { code: 'token_revoked' });

  // Reuse detection with a short grace window (mirrors the first-party refresh
  // logic): a freshly-rotated token is a benign retry; an old replay revokes
  // every token of this grant.
  if (tok.refresh_rotated_at) {
    const agoMs = Date.now() - new Date(tok.refresh_rotated_at).getTime();
    if (agoMs <= 60 * 1000) return unauthorized(res, 'already rotated — retry');
    await supabase.from('oauth_tokens').update({ revoked_at: new Date().toISOString() })
      .eq('grant_id', tok.grant_id).is('revoked_at', null);
    audit({
      userId: tok.user_id, deviceId: tok.device_id,
      action: 'oauth.token.reuse_detected', targetType: 'oauth_grant', targetId: tok.grant_id,
      metadata: { client_id: tok.client_id }, req,
    });
    return unauthorized(res, 'refresh token reuse detected — tokens revoked', { code: 'token_revoked' });
  }
  if (new Date(tok.expires_at) < new Date()) return unauthorized(res, 'refresh_token expired', { code: 'token_revoked' });

  // Rotate: mint a new token row, mark the old one rotated.
  const scopes = tok.scopes || [];
  const grantLike = { user_id: tok.user_id, device_id: tok.device_id, client_id: tok.client_id };
  const { accessToken, refreshToken, refreshHash } = issueTokens(grantLike, scopes);
  const refreshExpires = new Date(Date.now() + config.oauth.refreshTtl * 1000).toISOString();

  await supabase.from('oauth_tokens')
    .update({ refresh_rotated_at: new Date().toISOString(), last_used_at: new Date().toISOString() })
    .eq('id', tok.id);
  const { error } = await supabase.from('oauth_tokens').insert({
    grant_id: tok.grant_id,
    client_id: tok.client_id,
    user_id: tok.user_id,
    device_id: tok.device_id,
    scopes,
    refresh_token_hash: refreshHash,
    expires_at: refreshExpires,
  });
  if (error) return serverError(res, 'Could not rotate token', error);

  ok(res, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.oauth.accessTtl,
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  });
}

module.exports = { token };
