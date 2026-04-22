'use strict';

const crypto = require('node:crypto');

/** SHA-256 hex of utf-8 string, optionally salted with a pepper. */
function sha256(str, pepper = '') {
  return crypto.createHash('sha256').update(str + pepper).digest('hex');
}

/** Random n-byte hex string. */
function randomHex(nBytes = 16) {
  return crypto.randomBytes(nBytes).toString('hex');
}

/** Random base64url of n bytes. */
function randomBase64Url(nBytes = 32) {
  return crypto.randomBytes(nBytes).toString('base64url');
}

/** Numeric OTP code of given length. */
function otpCode(length = 6) {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return n.toString().padStart(length, '0');
}

/** Short pairing code (letters+digits, no confusing chars). */
function pairingCode(length = 5) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const rand = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += alphabet[rand[i] % alphabet.length];
  return out;
}

/** HMAC-SHA256 hex. */
function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/** Timing-safe string compare. Returns false for unequal length. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Derive the short fingerprint shown in UI from a public key (bytes or buffer). */
function deviceFingerprint(publicKeyBytes) {
  const hash = crypto.createHash('sha256').update(publicKeyBytes).digest();
  // Take 8 bytes, format as 4 groups of 4 uppercase hex
  const hex = hash.subarray(0, 8).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)} ${hex.slice(12, 16)}`;
}

module.exports = {
  sha256, randomHex, randomBase64Url, otpCode, pairingCode, hmac, safeEqual,
  deviceFingerprint,
};
