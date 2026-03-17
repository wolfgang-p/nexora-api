const { authenticate } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const convRoutes = require('./routes/conversations');
const mediaRoutes = require('./routes/media');
const { sendJSON, sendError } = require('./utils/response');

async function routeRequest(req, res) {
  const urlParams = req.url.split('?')[0]; 
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Extension');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // PUBLIC ROUTES
    if (method === 'GET' && urlParams === '/health') {
      return sendJSON(res, 200, { status: 'OK' });
    }

    if (method === 'POST' && urlParams === '/auth/request-otp') {
      const body = await parseJSONBody(req);
      return await authRoutes.handleRequestOTP(req, res, body);
    }

    if (method === 'POST' && urlParams === '/auth/verify-otp') {
      const body = await parseJSONBody(req);
      return await authRoutes.handleVerifyOTP(req, res, body);
    }

    // PROTECTED ROUTES
    if (!authenticate(req, res)) return;

    if (method === 'POST' && urlParams === '/auth/complete-profile') {
      const body = await parseJSONBody(req);
      return await authRoutes.handleCompleteProfile(req, res, body);
    }

    if (method === 'GET' && urlParams === '/users/search') {
      return await userRoutes.handleSearchUsers(req, res, req.url);
    }

    if (method === 'PUT' && urlParams === '/users/profile') {
      const body = await parseJSONBody(req);
      return await userRoutes.handleUpdateProfile(req, res, body);
    }

    if (method === 'GET' && urlParams.match(/^\/users\/([^\/]+)\/profile$/)) {
      const id = urlParams.split('/')[2];
      return await userRoutes.handleGetProfile(req, res, id);
    }

    if (method === 'GET' && urlParams === '/conversations') {
      return await convRoutes.handleListConversations(req, res);
    }

    if (method === 'POST' && urlParams === '/conversations') {
      const body = await parseJSONBody(req);
      return await convRoutes.handleCreateConversation(req, res, body);
    }

    if (method === 'GET' && urlParams.match(/^\/conversations\/([^\/]+)\/messages$/)) {
      const id = urlParams.split('/')[2];
      return await convRoutes.handleGetMessages(req, res, req.url, id);
    }

    // MEDIA
    if (method === 'POST' && urlParams === '/media/upload') {
      if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        return sendError(res, 400, 'Media upload requires raw binary stream.');
      }
      return await mediaRoutes.handleMediaUpload(req, res);
    }

    sendError(res, 404, 'Not Found');
  } catch (err) {
    console.error('Unhandled Route Error:', err);
    sendError(res, 500, 'Internal Server Error');
  }
}

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { 
      try { 
        resolve(data ? JSON.parse(data) : {}); 
      } 
      catch (e) { 
        resolve({}); 
      }
    });
    req.on('error', reject);
  });
}

module.exports = { routeRequest };
