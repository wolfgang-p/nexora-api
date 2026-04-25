'use strict';

const config = require('./config');
const { notFound, ok, serverError } = require('./util/response');
const { authenticate, requireAdmin } = require('./auth/middleware');
const { counter, httpResponse, observe } = require('./util/metrics');
const logger = require('./util/logger');

// Route modules
const otp = require('./auth/otp');
const pairingCreate = require('./pairing/create');
const pairingClaim = require('./pairing/claim');
const pairingDeliver = require('./pairing/deliver');
const pairingPoll = require('./pairing/poll');
const pairingToken = require('./pairing/token');
const users = require('./users');
const devices = require('./devices');
const conversations = require('./conversations');
const messagesSend = require('./messages/send');
const messagesList = require('./messages/list');
const messagesRead = require('./messages/read');
const messagesDelete = require('./messages/delete');
const messagesEdit = require('./messages/edit');
const reactions = require('./reactions');
const media = require('./media/upload');
const mediaDownload = require('./media/download');
const smsWebhook = require('./sms/webhook');
const ai = require('./ai/endpoints');
const reminders = require('./reminders');
const messagesScheduled = require('./messages/scheduled');
const workspaces = require('./workspaces');
const tasks = require('./tasks');
const calls = require('./calls');
const webhooksReg = require('./webhooks/register');
const apiKeys = require('./api_keys');
const reports = require('./reports');
const admin = require('./admin');
const adminMetrics = require('./admin/metrics');
const gdpr = require('./users/gdpr');
const publicChannels = require('./public/channels');
const polls = require('./polls');
const threads = require('./messages/thread');
const stories = require('./stories');
const drive = require('./drive');
const feedback = require('./feedback');

/**
 * Tiny route matcher. Routes are tuples: [method, pattern, handler, { auth }]
 * Pattern supports :param and :param+ (rest). Returns 404 if no match.
 */
const routes = [];

function r(method, pattern, handler, opts = {}) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/\/:([^/]+)/g, (_, k) => {
    keys.push(k);
    return '/([^/]+)';
  }) + '/?$');
  routes.push({
    method, regex, keys, handler,
    auth: opts.auth !== false,
    admin: opts.admin === true,
  });
}

// --- Health ---
r('GET', '/health', async (req, res) => ok(res, { ok: true }), { auth: false });

// --- Auth ---
r('POST', '/auth/request-otp', otp.requestOtp, { auth: false });
// Twilio delivery callback — signature-verified inside the handler.
r('POST', '/sms/twilio-status', smsWebhook.twilioStatus, { auth: false });
r('POST', '/auth/verify-otp', otp.verifyOtp, { auth: false });
r('POST', '/auth/refresh', otp.refresh, { auth: false });
r('POST', '/auth/logout', otp.logout);

// --- Pairing ---
r('POST', '/pairing/sessions', pairingCreate.createPairing, { auth: false });
r('GET', '/pairing/sessions/:id', pairingPoll.pollPairing, { auth: false });
r('POST', '/pairing/sessions/:id/claim', pairingClaim.claimPairing);
r('POST', '/pairing/sessions/:id/deliver', pairingDeliver.deliverPairing);
r('GET', '/pairing/sessions/:id/token', pairingToken.getPairingToken, { auth: false });

// --- Users ---
r('GET', '/users/me', users.me);
r('PUT', '/users/me', users.updateMe);
r('GET', '/users/search', users.search);
r('GET', '/users/blocked', users.listBlocked);
r('POST', '/users/discover', users.discover);
r('GET', '/users/:id', users.getUser);
r('POST', '/users/:id/block', users.block);
r('DELETE', '/users/:id/block', users.unblock);

// --- Devices ---
r('GET', '/devices', devices.listOwnDevices);
r('PUT', '/devices/:id', devices.updateDevice);
r('DELETE', '/devices/:id', devices.revokeDevice);
r('POST', '/devices/push-token', devices.registerPushToken);
r('GET', '/conversations/:id/devices', devices.listConversationDevices);

// --- Conversations ---
r('GET', '/conversations', conversations.listConversations);
r('POST', '/conversations', conversations.createConversation);
r('GET', '/conversations/:id/info', conversations.getConversationInfo);
r('PUT', '/conversations/:id', conversations.updateConversation);
r('POST', '/conversations/:id/members', conversations.addMembers);
r('DELETE', '/conversations/:id/members/:userId', conversations.removeMember);
r('PUT', '/conversations/:id/members/:userId/role', conversations.changeRole);

// --- Messages ---
r('POST', '/messages', messagesSend.sendMessage);
r('GET', '/conversations/:id/messages', messagesList.listMessages);
r('POST', '/messages/:id/delivered', messagesRead.markDelivered);
r('POST', '/messages/:id/read', messagesRead.markRead);
r('DELETE', '/messages/:id', messagesDelete.deleteMessage);
r('PUT', '/messages/:id', messagesEdit.editMessage);

// --- Scheduled messages ---
r('GET',    '/messages/scheduled',     messagesScheduled.list);
r('POST',   '/messages/scheduled',     messagesScheduled.create);
r('DELETE', '/messages/scheduled/:id', messagesScheduled.destroy);

// --- Reminders ---
r('GET',    '/reminders',     reminders.list);
r('POST',   '/reminders',     reminders.create);
r('PUT',    '/reminders/:id', reminders.update);
r('DELETE', '/reminders/:id', reminders.destroy);

// --- Reactions ---
r('GET', '/messages/:id/reactions', reactions.list);
r('POST', '/messages/:id/reactions', reactions.add);
r('DELETE', '/messages/:id/reactions/:emoji', reactions.remove);

// --- Media (local disk) ---
r('POST', '/media/upload', media.upload);
// Avatars live in /media/:id with conversation_id=NULL and need to be
// accessible from <img src> tags (no Authorization header possible). The
// handler itself enforces auth when the object belongs to a conversation.
r('GET', '/media/:id', mediaDownload.download, { auth: false });
r('POST', '/media/:id/recipients', media.postRecipients);
r('GET', '/media/:id/key', media.getMyKey);

// --- Workspaces ---
r('GET', '/workspaces', workspaces.list);
r('POST', '/workspaces', workspaces.create);
r('GET', '/workspaces/:id', workspaces.get);
r('PUT', '/workspaces/:id', workspaces.update);
r('DELETE', '/workspaces/:id', workspaces.destroy);
r('POST', '/workspaces/:id/invites', workspaces.createInvite);
r('POST', '/workspaces/:id/channels', workspaces.createChannel);
r('POST', '/workspaces/join', workspaces.joinByCode);

// --- Tasks ---
r('GET', '/tasks', tasks.list);
r('POST', '/tasks', tasks.create);
r('PUT', '/tasks/:id', tasks.update);
r('DELETE', '/tasks/:id', tasks.destroy);
r('GET', '/tasks/lists', tasks.listLists);
r('POST', '/tasks/lists', tasks.createList);

// --- Calls ---
r('GET', '/calls', calls.list);
r('GET', '/calls/ice-servers', calls.iceServers);
r('POST', '/calls', calls.start);
r('POST', '/calls/:id/join', calls.join);
r('POST', '/calls/:id/reject', calls.reject);
r('POST', '/calls/:id/leave', calls.leave);
r('POST', '/calls/:id/end', calls.end);

// --- Webhooks ---
r('GET', '/webhooks', webhooksReg.list);
r('POST', '/webhooks', webhooksReg.create);
r('DELETE', '/webhooks/:id', webhooksReg.destroy);

// --- AI ---
r('GET',  '/ai/status',         ai.status);
r('POST', '/ai/extract-tasks',  ai.extractTasks);
r('POST', '/ai/smart-replies',  ai.smartReplies);
r('POST', '/ai/summarize',      ai.summarize);
r('POST', '/ai/translate',      ai.translate);
r('POST', '/ai/transcribe',     ai.transcribeVoice);

// --- API keys ---
r('GET', '/workspaces/:id/api-keys', apiKeys.list);
r('POST', '/workspaces/:id/api-keys', apiKeys.create);
r('DELETE', '/api-keys/:id', apiKeys.revoke);

// --- Reports (user-facing) ---
r('POST', '/reports',                    reports.createReport);
r('POST', '/admin/appeals',              reports.createAppeal);

// --- GDPR self-service ---
r('GET',    '/users/me/export', gdpr.exportMe);
r('DELETE', '/users/me',        gdpr.deleteMe);

// --- Admin: overview ---
r('GET',    '/admin/stats',               admin.stats,            { admin: true });
// --- Admin: users ---
r('GET',    '/admin/users',               admin.listUsers,        { admin: true });
r('GET',    '/admin/users/:id',           admin.getUser,          { admin: true });
r('POST',   '/admin/users/:id/force-logout', admin.forceLogout,   { admin: true });
r('POST',   '/admin/users/:id/set-admin', admin.setAdmin,         { admin: true });
r('POST',   '/admin/users/:id/ban',       reports.adminBanUser,   { admin: true });
r('DELETE', '/admin/users/:id/ban',       reports.adminUnbanUser, { admin: true });
r('DELETE', '/admin/users/:id',           admin.deleteUser,       { admin: true });
// --- Admin: conversations ---
r('GET',    '/admin/conversations',       admin.listConversations, { admin: true });
r('GET',    '/admin/conversations/:id',   admin.getConversation,   { admin: true });
// --- Admin: media ---
r('GET',    '/admin/media',               admin.listMedia,        { admin: true });
r('POST',   '/admin/media/:id/delete',    admin.deleteMedia,      { admin: true });
// --- Admin: pairings ---
r('GET',    '/admin/pairings',            admin.listPairings,     { admin: true });
// --- Admin: webhooks ---
r('GET',    '/admin/webhooks',            admin.listWebhooks,     { admin: true });
r('GET',    '/admin/webhooks/deliveries', admin.listDeliveries,   { admin: true });
r('GET',    '/admin/webhooks/events',     admin.listEventLog,     { admin: true });
// --- Admin: api keys ---
r('GET',    '/admin/api-keys',            admin.listApiKeys,      { admin: true });
r('DELETE', '/admin/api-keys/:id',        admin.revokeApiKey,     { admin: true });
// --- Admin: feature flags ---
r('GET',    '/admin/feature-flags',       admin.listFlags,        { admin: true });
r('POST',   '/admin/feature-flags',       admin.upsertFlag,       { admin: true });
r('DELETE', '/admin/feature-flags/:key',  admin.deleteFlag,       { admin: true });
// --- Admin: retention ---
r('GET',    '/admin/retention',           admin.listRetention,    { admin: true });
r('POST',   '/admin/retention',           admin.upsertRetention,  { admin: true });
// --- Admin: audit ---
r('GET',    '/audit',                     admin.listAudit,        { admin: true });
// --- Public channels ---
r('POST',   '/conversations/:id/public',  publicChannels.publish);
r('PUT',    '/conversations/:id/public',  publicChannels.updatePublic);
r('DELETE', '/conversations/:id/public',  publicChannels.unpublish);
r('GET',    '/public/channels/:slug',     publicChannels.viewPublic, { auth: false });

// --- Polls ---
r('POST',   '/polls/:id/vote',     polls.vote);
r('DELETE', '/polls/:id/vote',     polls.retract);
r('GET',    '/polls/:id/results',  polls.results);
r('POST',   '/polls/:id/close',    polls.close);

// --- Threads ---
r('GET',  '/messages/:id/thread',      threads.listThread);
r('POST', '/messages/:id/thread/read', threads.markThreadRead);

// --- Stories ---
r('POST',   '/stories',                          stories.create);
r('GET',    '/stories/feed',                     stories.feed);
r('GET',    '/stories/:id',                      stories.getOne);
r('DELETE', '/stories/:id',                      stories.destroy);
r('POST',   '/stories/:id/view',                 stories.markViewed);
r('POST',   '/stories/:id/reactions',            stories.react);
r('DELETE', '/stories/:id/reactions/:emoji',     stories.unreact);

// --- Feedback ---
r('POST',   '/feedback',                        feedback.submit);
r('GET',    '/admin/feedback',                  feedback.adminList,    { admin: true });
r('GET',    '/admin/feedback/:id',              feedback.adminGet,     { admin: true });
r('POST',   '/admin/feedback/:id/resolve',      feedback.adminResolve, { admin: true });

// --- Workspace Drive ---
r('GET',    '/workspaces/:id/files',               drive.list);
r('POST',   '/workspaces/:id/files',               drive.attach);
r('GET',    '/workspaces/:id/files/:file_id',      drive.getOne);
r('PUT',    '/workspaces/:id/files/:file_id',      drive.update);
r('DELETE', '/workspaces/:id/files/:file_id',      drive.destroy);
r('POST',   '/workspaces/:id/files/:file_id/pin',  drive.pin);

// --- Admin: reports moderation ---
r('GET',    '/admin/reports',             reports.adminListReports,  { admin: true });
r('GET',    '/admin/reports/:id',         reports.adminGetReport,    { admin: true });
r('POST',   '/admin/reports/:id/resolve', reports.adminResolveReport, { admin: true });
// --- Admin: appeals ---
r('GET',    '/admin/appeals',             reports.adminListAppeals,   { admin: true });
r('POST',   '/admin/appeals/:id/resolve', reports.adminResolveAppeal, { admin: true });

// ----------------------------------------------------------------------------

function parseQuery(url) {
  const q = {};
  const i = url.indexOf('?');
  if (i < 0) return { path: url, query: q };
  const path = url.slice(0, i);
  for (const pair of url.slice(i + 1).split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return { path, query: q };
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = config.corsOrigins.length === 0 || config.corsOrigins.includes(origin);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Koro-Signature',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  // Allow origin if configured OR if wildcard mode
  if (allowed) {
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
    } else if (config.corsOrigins.length === 0 || config.corsOrigins.includes('*')) {
      // Wildcard mode: allow all (React Native fetch doesn't send Origin header)
      headers['Access-Control-Allow-Origin'] = '*';
    }
  }
  return headers;
}

async function handleRequest(req, res) {
  const startNs = process.hrtime.bigint();
  counter('http_requests_total');

  // Prometheus scrape endpoint — no CORS, no JSON, own auth path.
  if (req.method === 'GET' && (req.url || '').startsWith('/metrics')) {
    adminMetrics.handler(req, res);
    return;
  }

  const cors = corsHeaders(req);
  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  // Apply CORS to every response
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

  // Record status + latency on close. `writeHead` is monkey-wrapped so we
  // can read the final status even if the handler didn't use writeHead.
  res.on('finish', () => {
    httpResponse(res.statusCode);
    observe('http_request_duration_seconds', Number(process.hrtime.bigint() - startNs) / 1e9);
  });

  const { path, query } = parseQuery(req.url || '/');

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const m = path.match(route.regex);
    if (!m) continue;
    const params = {};
    route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

    try {
      if (route.auth) {
        const authed = await authenticate(req, res);
        if (!authed) return;
      }
      if (route.admin) {
        const ok = await requireAdmin(req, res);
        if (!ok) return;
      }
      await route.handler(req, res, { params, query });
    } catch (err) {
      logger.error('[router]', err);
      try { require('./util/sentry').captureException(err, { route: route.regex.source }); } catch { /* ignore */ }
      serverError(res, 'Internal error', err);
    }
    return;
  }

  notFound(res);
}

module.exports = { handleRequest };
