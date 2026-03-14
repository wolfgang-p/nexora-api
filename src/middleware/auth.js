const { verifyJWT } = require('../crypto/index.js');
const { sendError } = require('../utils/response.js');

function authenticate(req, res) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, 401, 'Unauthorized');
    return false;
  }

  const token = authHeader.split(' ')[1];
  const payload = verifyJWT(token);

  if (!payload) {
    sendError(res, 401, 'Invalid or expired token');
    return false;
  }

  req.user = payload; // { userId, phone, accountType }
  return true;
}

module.exports = { authenticate };
