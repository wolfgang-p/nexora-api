const { authenticate } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const convRoutes = require('./routes/conversations');
const groupRoutes = require('./routes/groups');
const mediaRoutes = require('./routes/media');
const { sendJSON, sendError } = require('./utils/response');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac',
  ogg: 'audio/ogg', wav: 'audio/wav', opus: 'audio/opus',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
};

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

  // STATIC FILE SERVING
  if (method === 'GET' && urlParams.startsWith('/public/')) {
    const relativePath = urlParams.slice('/public/'.length);
    // Prevent path traversal
    const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end();
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
    return;
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

    // GROUP MANAGEMENT ROUTES (must come before generic conversation routes)
    if (method === 'GET' && urlParams.match(/^\/conversations\/([^\/]+)\/info$/)) {
      const id = urlParams.split('/')[2];
      return await groupRoutes.handleGetGroupInfo(req, res, id);
    }

    if (method === 'PUT' && urlParams.match(/^\/conversations\/([^\/]+)\/settings$/)) {
      const id = urlParams.split('/')[2];
      const body = await parseJSONBody(req);
      return await groupRoutes.handleUpdateGroupSettings(req, res, id, body);
    }

    if (method === 'POST' && urlParams.match(/^\/conversations\/([^\/]+)\/participants$/)) {
      const id = urlParams.split('/')[2];
      const body = await parseJSONBody(req);
      return await groupRoutes.handleAddMembers(req, res, id, body);
    }

    if (method === 'DELETE' && urlParams.match(/^\/conversations\/([^\/]+)\/participants\/([^\/]+)$/)) {
      const parts = urlParams.split('/');
      const convId = parts[2];
      const userId = parts[4];
      return await groupRoutes.handleRemoveMember(req, res, convId, userId);
    }

    if (method === 'PUT' && urlParams.match(/^\/conversations\/([^\/]+)\/participants\/([^\/]+)\/role$/)) {
      const parts = urlParams.split('/');
      const convId = parts[2];
      const userId = parts[4];
      const body = await parseJSONBody(req);
      return await groupRoutes.handleChangeRole(req, res, convId, userId, body);
    }

    if (method === 'POST' && urlParams.match(/^\/conversations\/([^\/]+)\/leave$/)) {
      const id = urlParams.split('/')[2];
      return await groupRoutes.handleLeaveGroup(req, res, id);
    }

    if (method === 'PUT' && urlParams.match(/^\/conversations\/([^\/]+)$/) && !urlParams.includes('/archive') && !urlParams.includes('/unarchive')) {
      const id = urlParams.split('/')[2];
      const body = await parseJSONBody(req);
      return await groupRoutes.handleUpdateGroup(req, res, id, body);
    }

    if (method === 'GET' && urlParams.match(/^\/conversations\/([^\/]+)\/messages$/)) {
      const id = urlParams.split('/')[2];
      return await convRoutes.handleGetMessages(req, res, req.url, id);
    }

    if (method === 'GET' && urlParams === '/conversations/archived') {
      return await convRoutes.handleListArchivedConversations(req, res);
    }

    if (method === 'PUT' && urlParams.match(/^\/conversations\/([^\/]+)\/archive$/)) {
      const id = urlParams.split('/')[2];
      return await convRoutes.handleArchiveConversation(req, res, id);
    }

    if (method === 'PUT' && urlParams.match(/^\/conversations\/([^\/]+)\/unarchive$/)) {
      const id = urlParams.split('/')[2];
      return await convRoutes.handleUnarchiveConversation(req, res, id);
    }

    if (method === 'DELETE' && urlParams.match(/^\/conversations\/([^\/]+)\/all$/)) {
      const id = urlParams.split('/')[2];
      return await convRoutes.handleDeleteForAll(req, res, id);
    }

    if (method === 'DELETE' && urlParams.match(/^\/messages\/([^\/]+)$/)) {
      const id = urlParams.split('/')[2];
      return await convRoutes.handleDeleteMessage(req, res, id);
    }

    if (method === 'DELETE' && urlParams.match(/^\/conversations\/([^\/]+)$/)) {
      const id = urlParams.split('/')[2];
      return await convRoutes.handleDeleteForMe(req, res, id);
    }

    if (method === 'GET' && urlParams === '/users/settings') {
      return await userRoutes.handleGetSettings(req, res);
    }

    if (method === 'PUT' && urlParams === '/users/settings') {
      const body = await parseJSONBody(req);
      return await userRoutes.handleUpdateSettings(req, res, body);
    }

    if (method === 'GET' && urlParams === '/users/blocked') {
      return await userRoutes.handleListBlockedUsers(req, res);
    }

    if (method === 'POST' && urlParams === '/users/block') {
      const body = await parseJSONBody(req);
      return await userRoutes.handleBlockUser(req, res, body);
    }

    if (method === 'DELETE' && urlParams.match(/^\/users\/([^\/]+)\/block$/)) {
      const id = urlParams.split('/')[2];
      return await userRoutes.handleUnblockUser(req, res, id);
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
