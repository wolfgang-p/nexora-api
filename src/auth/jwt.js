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

module.exports = { signAccess, verifyAccess };
