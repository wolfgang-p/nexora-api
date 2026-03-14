const crypto = require('crypto');

const secret = process.env.JWT_SECRET || 'supersecret';

function hashOTP(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Basic JWT implementation using crypto.createHmac
function signJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
    
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyJWT(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  
  const [encodedHeader, encodedPayload, signature] = parts;
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
    
  if (signature !== expectedSignature) return null;
  
  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
}

function generateKeyPair() {
  return crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

module.exports = {
  hashOTP,
  generateOTP,
  signJWT,
  verifyJWT,
  generateKeyPair
};
