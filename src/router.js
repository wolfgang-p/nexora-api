const { authenticate } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const convRoutes = require('./routes/conversations');
const groupRoutes = require('./routes/groups');
const mediaRoutes = require('./routes/media');
const reactionRoutes = require('./routes/reactions');
const workspaceRoutes = require('./routes/workspaces');
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

  console.log(`\n--- [${new Date().toISOString()}] Incoming Request ---`);
  console.log(`Method: ${method}`);
  console.log(`URL: ${req.url}`);
  console.log(`Headers:`, JSON.stringify(req.headers));

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
    
    // Support Range requests (Required by iOS AVPlayer)
    const stat = fs.statSync(filePath);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;
      
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunksize);
      res.writeHead(206);
      
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Accept-Ranges', 'bytes');
      res.writeHead(200);
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  try {
    if (method === 'POST' && urlParams === '/auth/request-otp') {
      console.log('[Router] Matched /auth/request-otp');
      const body = await parseJSONBody(req);
      return await authRoutes.handleRequestOTP(req, res, body);
    }

    if (method === 'POST' && urlParams === '/auth/verify-otp') {
      console.log('[Router] Matched /auth/verify-otp');
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

    // WORKSPACE ROUTES
    if (method === 'GET' && urlParams === '/workspaces') {
      console.log('[Router] Matched GET /workspaces');
      return await workspaceRoutes.handleListWorkspaces(req, res);
    }
    if (method === 'POST' && urlParams === '/workspaces') {
      console.log('[Router] Matched POST /workspaces');
      const body = await parseJSONBody(req);
      console.log('[Router] Body parsed for POST /workspaces:', body);
      return await workspaceRoutes.handleCreateWorkspace(req, res, body);
    }
    if (method === 'POST' && urlParams === '/workspaces/join') {
      const body = await parseJSONBody(req);
      return await workspaceRoutes.handleJoinWorkspaceWithCode(req, res, body);
    }
    if (method === 'GET' && urlParams.match(/^\/workspaces\/([^\/]+)$/)) {
      const match = urlParams.match(/^\/workspaces\/([^\/]+)$/);
      return await workspaceRoutes.handleGetWorkspaceDetails(req, res, match[1]);
    }
    if (method === 'PUT' && urlParams.match(/^\/workspaces\/([^\/]+)$/)) {
      const match = urlParams.match(/^\/workspaces\/([^\/]+)$/);
      const body = await parseJSONBody(req);
      return await workspaceRoutes.handleUpdateWorkspace(req, res, match[1], body);
    }
    if (method === 'POST' && urlParams.match(/^\/workspaces\/([^\/]+)\/join-code$/)) {
      const id = urlParams.split('/')[2];
      return await workspaceRoutes.handleGenerateJoinCode(req, res, id);
    }
    if (method === 'POST' && urlParams.match(/^\/workspaces\/([^\/]+)\/channels$/)) {
      const id = urlParams.split('/')[2];
      const body = await parseJSONBody(req);
      return await workspaceRoutes.handleCreateChannel(req, res, id, body);
    }
    if (method === 'GET' && urlParams.match(/^\/workspaces\/([^\/]+)\/files$/)) {
      const id = urlParams.split('/')[2];
      return await workspaceRoutes.handleGetWorkspaceFiles(req, res, id);
    }
    if (method === 'GET' && urlParams.match(/^\/channels\/([^\/]+)\/messages$/)) {
      const id = urlParams.split('/')[2];
      return await workspaceRoutes.handleGetChannelMessages(req, res, id);
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

    // REACTIONS
    if (method === 'GET' && urlParams.match(/^\/messages\/([^\/]+)\/reactions$/)) {
      const id = urlParams.split('/')[2];
      return await reactionRoutes.handleGetReactions(req, res, id);
    }

    if (method === 'POST' && urlParams.match(/^\/messages\/([^\/]+)\/reactions$/)) {
      const id = urlParams.split('/')[2];
      const body = await parseJSONBody(req);
      return await reactionRoutes.handleAddReaction(req, res, id, body);
    }

    if (method === 'DELETE' && urlParams.match(/^\/messages\/([^\/]+)\/reactions\/([^\/]+)$/)) {
      const parts = urlParams.split('/');
      const messageId = parts[2];
      const emoji = parts[4];
      return await reactionRoutes.handleRemoveReaction(req, res, messageId, emoji);
    }

    const originalWriteHead = res.writeHead;
    res.writeHead = function(statusCode, headers) {
      console.log(`[${new Date().toISOString()}] Response: ${statusCode} ${req.method} ${req.url}`);
      return originalWriteHead.apply(this, arguments);
    };

    try {
      // MEDIA
      if (method === 'POST' && urlParams === '/media/upload') {
        if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
          return sendError(res, 400, 'Media upload requires raw binary stream.');
        }
        return await mediaRoutes.handleMediaUpload(req, res);
      }

      sendError(res, 404, 'Not Found');
    } catch (e) {
      console.error(`[${new Date().toISOString()}] ROUTE ERROR:`, e);
      sendError(res, 500, 'Internal Server Error');
    }
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
