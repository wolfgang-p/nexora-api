'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Sign a short-lived access token.
 * Claims: sub=userId, did=deviceId, typ='access'
 */
function signAccess({ userId, deviceId }) {
  return jwt.sign(
    { sub: userId, did: deviceId, typ: 'access' },
    config.jwt.secret,
    { algorithm: 'HS256', expiresIn: config.jwt.accessTtl, issuer: 'koro', audience: 'koro-client' },
  );
}

/**
 * Sign a "Login with Koro" OAuth access token. Same shape as a normal access
 * token (sub/did) so every existing handler works unchanged, plus:
 *   typ='oauth'  — distinguishes it from a first-party session token
 *   scp=[...]    — the granted scopes; enforced by requireOAuthScope().
 *   cid=clientId — the developer app this token belongs to (for auditing).
 * OAuth access tokens are short-lived; the developer refreshes via /oauth/token.
 */
function signOAuthAccess({ userId, deviceId, scopes, clientId, ttl }) {
  return jwt.sign(
    { sub: userId, did: deviceId, typ: 'oauth', scp: scopes || [], cid: clientId || null },
    config.jwt.secret,
    {
      algorithm: 'HS256',
      expiresIn: ttl || config.oauth.accessTtl,
      issuer: 'koro',
      audience: 'koro-client',
    },
  );
}

/**
 * Verify an access token (first-party OR OAuth). Returns
 *   { userId, deviceId, scopes, clientId }
 * where `scopes` is null for a full-access first-party token and an array of
 * granted scopes for an OAuth token. Throws on any invalid token.
 */
function verifyAccess(token) {
  const payload = jwt.verify(token, config.jwt.secret, {
    algorithms: ['HS256'],
    issuer: 'koro',
    audience: 'koro-client',
  });
  const isOauth = payload.typ === 'oauth';
  if (payload.typ !== 'access' && !isOauth) throw new Error('wrong token type');
  if (!payload.sub || !payload.did) throw new Error('malformed token');
  return {
    userId: payload.sub,
    deviceId: payload.did,
    scopes: isOauth ? (Array.isArray(payload.scp) ? payload.scp : []) : null,
    clientId: isOauth ? payload.cid || null : null,
  };
}

/**
 * Short-lived (5-min) "login challenge" token used to bridge the OTP
 * step → TOTP step during a login that requires 2FA. NOT a session
 * token: only `/auth/totp/verify` accepts it.
 */
function signLoginChallenge({ userId, phone }) {
  return jwt.sign(
    { sub: userId, phone, typ: 'login_challenge' },
    config.jwt.secret,
    { algorithm: 'HS256', expiresIn: '5m', issuer: 'koro', audience: 'koro-client' },
  );
}

function verifyLoginChallenge(token) {
  try {
    const payload = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'], issuer: 'koro', audience: 'koro-client',
    });
    if (payload.typ !== 'login_challenge') return null;
    return { uid: payload.sub, phone: payload.phone };
  } catch { return null; }
}

module.exports = { signAccess, signOAuthAccess, verifyAccess, signLoginChallenge, verifyLoginChallenge };
