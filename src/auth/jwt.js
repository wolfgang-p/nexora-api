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
 * Verify access token. Returns { userId, deviceId } or throws.
 */
function verifyAccess(token) {
  const payload = jwt.verify(token, config.jwt.secret, {
    algorithms: ['HS256'],
    issuer: 'koro',
    audience: 'koro-client',
  });
  if (payload.typ !== 'access') throw new Error('wrong token type');
  if (!payload.sub || !payload.did) throw new Error('malformed token');
  return { userId: payload.sub, deviceId: payload.did };
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

module.exports = { signAccess, verifyAccess, signLoginChallenge, verifyLoginChallenge };
