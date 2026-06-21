'use strict';

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, notFound, forbidden, serverError } = require('../util/response');
const { pairingCode, deviceFingerprint } = require('../util/crypto');
const { audit } = require('../util/audit');
const config = require('../config');
const { sanitizeScopes, OAUTH_SCOPES } = require('./scopes');

/**
 * POST /oauth/authorize   (no auth — the developer's site starts the flow)
 *
 * Begins a "Login with Koro" consent session. The developer calls this from
 * their backend; we return a grant id + a QR payload the user scans in the
 * Koro app. The user then approves (or denies) in-app.
 *
 * Body: {
 *   client_id,                         // the registered app
 *   redirect_uri?,                     // must match one of the client's
 *   scopes: [],                        // requested permissions (subset of client's)
 *   state?,                            // opaque, echoed back at the end
 *   code_challenge?, code_challenge_method?,   // PKCE (required for public clients)
 *   ephemeral_public_key?,             // app's X25519 pub (b64) for E2E secret delivery
 * }
 * Returns: { grant_id, pairing_code, qr_payload, expires_at, requested_scopes }
 */
async function authorize(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.client_id) return badRequest(res, 'client_id required');

  const { data: client } = await supabase.from('oauth_clients')
    .select('client_id, name, logo_url, redirect_uris, scopes, is_public, revoked_at')
    .eq('client_id', body.client_id).maybeSingle();
  if (!client || client.revoked_at) return notFound(res, 'Unknown client_id');

  // Validate redirect_uri against the registered allow-list.
  let redirectUri = body.redirect_uri || null;
  if (redirectUri) {
    if (!client.redirect_uris.includes(redirectUri)) {
      return badRequest(res, 'redirect_uri not registered for this client');
    }
  } else if (client.redirect_uris.length === 1) {
    redirectUri = client.redirect_uris[0];
  }

  // Requested scopes must be a subset of what the app registered.
  const requested = sanitizeScopes(body.scopes || [], client.scopes);
  if (!requested.length) return badRequest(res, 'no valid requested scopes');

  // PKCE: mandatory for public clients (no secret to authenticate with).
  if (client.is_public && !body.code_challenge) {
    return badRequest(res, 'code_challenge required for public clients (PKCE)');
  }
  const challengeMethod = body.code_challenge ? (body.code_challenge_method || 'S256') : null;
  if (challengeMethod && !['S256', 'plain'].includes(challengeMethod)) {
    return badRequest(res, 'unsupported code_challenge_method');
  }

  const code = pairingCode(6);
  const expires = new Date(Date.now() + config.oauth.grantTtl * 1000).toISOString();

  const { data: grant, error } = await supabase.from('oauth_grants').insert({
    client_id: client.client_id,
    pairing_code: code,
    requested_scopes: requested,
    redirect_uri: redirectUri,
    state: body.state || null,
    code_challenge: body.code_challenge || null,
    code_challenge_method: challengeMethod,
    ephemeral_public_key: body.ephemeral_public_key || null,
    expires_at: expires,
  }).select('id, pairing_code, expires_at').single();
  if (error) return serverError(res, 'Could not start authorization', error);

  // The QR payload the Koro app scans. JSON so the app can route to the
  // OAuth consent screen (vs. device pairing).
  const qrPayload = JSON.stringify({ t: 'koro_oauth', grant_id: grant.id, code: grant.pairing_code });

  created(res, {
    grant_id: grant.id,
    pairing_code: grant.pairing_code,
    qr_payload: qrPayload,
    expires_at: grant.expires_at,
    requested_scopes: requested,
  });
}

/**
 * GET /oauth/grants/:id   (no auth — polled by the developer site AND read by
 * the mobile consent screen)
 *
 * Returns the grant status and, for a pending grant, the consent metadata the
 * mobile app shows (app name, logo, requested scopes with labels). Never leaks
 * the authorization code; the dev gets that via redirect/poll only once the
 * status is 'approved'.
 */
async function getGrant(req, res, { params }) {
  const { data: g } = await supabase.from('oauth_grants')
    .select('id, client_id, pairing_code, requested_scopes, redirect_uri, state, status, expires_at, ephemeral_public_key')
    .eq('id', params.id).maybeSingle();
  if (!g) return notFound(res, 'Grant not found');

  const expired = new Date(g.expires_at) < new Date();
  const status = expired && g.status === 'pending' ? 'expired' : g.status;

  const { data: client } = await supabase.from('oauth_clients')
    .select('name, logo_url, homepage_url').eq('client_id', g.client_id).maybeSingle();

  // Decorate requested scopes with human labels for the consent screen.
  const scopeInfo = g.requested_scopes.map((id) => {
    const meta = OAUTH_SCOPES.find((s) => s.id === id);
    return { id, de: meta?.de || id, en: meta?.en || id };
  });

  const out = {
    grant_id: g.id,
    status,
    app: client ? { name: client.name, logo_url: client.logo_url, homepage_url: client.homepage_url } : null,
    requested_scopes: g.requested_scopes,
    scope_info: scopeInfo,
    ephemeral_public_key: g.ephemeral_public_key,
    state: g.state || null,
  };

  // On approval, the mobile app builds <redirect_uri>?code=…&state=… and opens
  // it, so a redirect-based dev gets the code that way. A dev WITHOUT a
  // redirect_uri (e.g. a CLI / native app polling this endpoint) is told the
  // grant is approved here and exchanges the code their own out-of-band way.
  // We deliberately never return the authorization code from this public poll
  // endpoint — it's only ever shown once, to the consenting user's device.
  ok(res, out);
}

/**
 * POST /oauth/grants/:id/approve   (authed as the consenting Koro user)
 *
 * The mobile app, after the user taps "Allow" on the consent screen, calls
 * this. It:
 *   1. provisions a per-grant `oauth` device owned by the user, carrying the
 *      developer app's identity_public_key (so message copies can be sealed to
 *      it and the dev — holding the matching secret — can open them);
 *   2. stores the user's sealed device-secret (history sync), exactly like
 *      pairing/deliver;
 *   3. mints a one-shot authorization code and flips the grant to 'approved'.
 *
 * Body: {
 *   granted_scopes: [],                 // user-confirmed subset of requested
 *   identity_public_key: b64,           // the per-grant device identity key
 *   device_secret_ciphertext?, device_secret_nonce?,  // sealed to the app's ephemeral key
 * }
 * Returns: { ok: true }  — the dev fetches the code via /oauth/grants/:id.
 */
async function approve(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.identity_public_key) return badRequest(res, 'identity_public_key required');

  const { data: g } = await supabase.from('oauth_grants').select('*').eq('id', params.id).maybeSingle();
  if (!g) return notFound(res, 'Grant not found');
  if (g.status !== 'pending') return forbidden(res, 'Grant is not pending');
  if (new Date(g.expires_at) < new Date()) return forbidden(res, 'Grant expired');

  const { data: client } = await supabase.from('oauth_clients')
    .select('client_id, name, scopes, revoked_at').eq('client_id', g.client_id).maybeSingle();
  if (!client || client.revoked_at) return forbidden(res, 'Client revoked');

  // The user can only grant a subset of what was requested (and of what the
  // app is allowed). granted ⊆ requested ⊆ client.scopes.
  const granted = sanitizeScopes(body.granted_scopes || g.requested_scopes, g.requested_scopes);
  if (!granted.length) return badRequest(res, 'no scopes granted');

  const pkBuf = Buffer.from(body.identity_public_key, 'base64');
  if (pkBuf.length < 16 || pkBuf.length > 256) {
    return badRequest(res, 'identity_public_key has unreasonable length');
  }

  // Provision the per-grant device (owned by the consenting user).
  const { data: device, error: devErr } = await supabase.from('devices').insert({
    user_id: req.auth.userId,
    kind: 'oauth',
    label: `Login mit Koro · ${client.name}`.slice(0, 80),
    identity_public_key: body.identity_public_key,
    fingerprint: deviceFingerprint(pkBuf),
  }).select('id, fingerprint').single();
  if (devErr) return serverError(res, 'Could not provision grant device', devErr);

  // One-shot authorization code. We store only its hash.
  const { randomBase64Url, sha256 } = require('../util/crypto');
  const authCode = randomBase64Url(32);
  const authCodeHash = sha256(authCode);

  const { error } = await supabase.from('oauth_grants').update({
    status: 'approved',
    user_id: req.auth.userId,
    device_id: device.id,
    granted_scopes: granted,
    authorization_code_hash: authCodeHash,
    device_secret_ciphertext: body.device_secret_ciphertext || null,
    device_secret_nonce: body.device_secret_nonce || null,
    device_secret_sender_key: body.sender_public_key || null,
    approved_at: new Date().toISOString(),
  }).eq('id', g.id);
  if (error) return serverError(res, 'Could not approve grant', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'oauth.grant.approve', targetType: 'oauth_grant', targetId: g.id,
    metadata: { client_id: g.client_id, scopes: granted }, req,
  });

  // Return the auth code to the APP so it can build the redirect for the dev.
  // (The app constructs <redirect_uri>?code=…&state=… and opens it.) The code
  // is shown only here, once, to the authenticated user's device.
  ok(res, {
    ok: true,
    authorization_code: authCode,
    redirect_uri: g.redirect_uri,
    state: g.state || null,
  });
}

/**
 * POST /oauth/grants/:id/deny   (authed as the consenting user)
 */
async function deny(req, res, { params }) {
  const { data: g } = await supabase.from('oauth_grants').select('id, status, client_id').eq('id', params.id).maybeSingle();
  if (!g) return notFound(res, 'Grant not found');
  if (g.status !== 'pending') return ok(res, { ok: true });

  await supabase.from('oauth_grants')
    .update({ status: 'denied', denied_at: new Date().toISOString(), user_id: req.auth.userId })
    .eq('id', g.id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'oauth.grant.deny', targetType: 'oauth_grant', targetId: g.id,
    metadata: { client_id: g.client_id }, req,
  });
  ok(res, { ok: true });
}

module.exports = { authorize, getGrant, approve, deny };
