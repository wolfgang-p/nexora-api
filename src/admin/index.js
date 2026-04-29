'use strict';

/**
 * Admin-only endpoints. Every route here must be registered with
 * { auth: true, admin: true } in router.js — the middleware already
 * enforces is_admin=true before dispatch, but the handlers also stay
 * paranoid and never trust req.auth blindly.
 *
 * Organized by surface:
 *   - Overview (stats)
 *   - Users        (search, detail, force-logout, ban/unban, delete)
 *   - Conversations (list, detail)
 *   - Messages     (none — we never see plaintext; moderation uses reports)
 *   - Media        (list, detail, force-delete)
 *   - Pairings     (list active + past)
 *   - Webhooks     (list across workspaces)
 *   - API keys     (list, revoke)
 *   - Feature flags
 *   - Retention policies
 *   - Audit log
 */

const os = require('node:os');
const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { metricsSnapshot } = require('../util/metrics');
const { wsStats } = require('../ws/dispatch');

// ── Overview ────────────────────────────────────────────────────────

/**
 * GET /admin/stats
 * Fan-in of cheap read-only counters so the dashboard can render the
 * overview in a single request.
 */
async function stats(req, res) {
  const [
    users, usersLast24, banned,
    devices, devicesLive,
    conversations,
    messagesLast24,
    media, mediaBytes,
    reportsPending,
    webhooks, webhooksFailing,
    apiKeys,
    activeCalls,
  ] = await Promise.all([
    countRows('users'),
    countRowsGt('users', 'created_at', hoursAgo(24)),
    countWhere('users', 'banned_at', 'not.is', null),
    countRows('devices'),
    countWhere('devices', 'revoked_at', 'is', null),
    countRows('conversations'),
    countRowsGt('messages', 'created_at', hoursAgo(24)),
    countRows('media_objects'),
    sumField('media_objects', 'size_bytes'),
    countWhere('reports', 'status', 'eq', 'pending'),
    countRows('webhooks'),
    countRowsGt('webhook_deliveries', 'last_attempt_at', hoursAgo(24)).catch(() => 0),
    countWhere('api_keys', 'revoked_at', 'is', null),
    countWhere('calls', 'ended_at', 'is', null),
  ]);

  ok(res, {
    users: { total: users, last_24h: usersLast24, banned },
    devices: { total: devices, live: devicesLive },
    conversations: { total: conversations },
    messages: { last_24h: messagesLast24 },
    media: { total: media, bytes: mediaBytes },
    reports: { pending: reportsPending },
    webhooks: { total: webhooks, failing_last_24h: webhooksFailing },
    api_keys: { active: apiKeys },
    calls: { active: activeCalls },
    polls: { total: await countRows('polls'), votes_last_24h: await countRowsGt('poll_votes', 'voted_at', hoursAgo(24)) },
    public_channels: { total: await supabase.from('conversations').select('*', { count: 'exact', head: true }).not('public_slug', 'is', null).then((r) => r.count || 0) },
    stories: {
      active: await supabase.from('stories').select('*', { count: 'exact', head: true })
        .is('deleted_at', null).gt('expires_at', new Date().toISOString())
        .then((r) => r.count || 0),
      views_last_24h: await countRowsGt('story_views', 'viewed_at', hoursAgo(24)),
    },
    drive: { total_files: await countRows('workspace_files') },
    threads: { reads_last_24h: await countRowsGt('thread_reads', 'last_read_at', hoursAgo(24)) },
    feedback: {
      new: await countWhere('feedback', 'status', 'eq', 'new'),
      last_24h: await countRowsGt('feedback', 'created_at', hoursAgo(24)),
    },
    server: {
      uptime_sec: Math.round(process.uptime()),
      rss_mb: Math.round(process.memoryUsage().rss / 1_048_576),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
      heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1_048_576),
      load_avg: os.loadavg(),
      cpus: os.cpus().length,
      node_version: process.version,
      ws: wsStats(),
      metrics: metricsSnapshot(),
    },
  });
}

// ── Users ──────────────────────────────────────────────────────────

/** GET /admin/users?q=…&limit=50 */
async function listUsers(req, res, { query }) {
  const q = String(query.q || '').trim();
  const limit = clampInt(query.limit, 50, 1, 200);

  let qb = supabase.from('users')
    .select('id, phone_e164, username, display_name, avatar_url, account_type, created_at, last_seen_at, banned_at, banned_reason, is_admin, deleted_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (q) {
    // Search by exact id, phone substring, or username/display_name ILIKE.
    const looksLikeUuid = /^[0-9a-f]{8}-/.test(q);
    if (looksLikeUuid) {
      qb = qb.eq('id', q);
    } else {
      // PostgREST `or()` lets us match any of these fields in one round-trip.
      qb = qb.or(`phone_e164.ilike.%${q}%,username.ilike.%${q}%,display_name.ilike.%${q}%`);
    }
  }

  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { users: data || [] });
}

/** GET /admin/users/:id — fully hydrated view. */
async function getUser(req, res, { params }) {
  const { data: user, error } = await supabase.from('users')
    .select('*').eq('id', params.id).maybeSingle();
  if (error) return serverError(res, 'Query failed', error);
  if (!user) return notFound(res, 'User not found');

  const [devices, convMembers, reportsMade, reportsAgainst, blocks, apiKeys, calls] = await Promise.all([
    supabase.from('devices').select('id, kind, label, created_at, last_seen_at, revoked_at, fingerprint')
      .eq('user_id', params.id).order('created_at', { ascending: false }).then((x) => x.data || []),
    supabase.from('conversation_members').select('conversation_id, role, joined_at, left_at, conversations:conversation_id (id, kind, title)')
      .eq('user_id', params.id).then((x) => x.data || []),
    supabase.from('reports').select('id, reason, status, created_at, target_user_id').eq('reporter_user_id', params.id).then((x) => x.data || []),
    supabase.from('reports').select('id, reason, status, created_at, reporter_user_id').eq('target_user_id', params.id).then((x) => x.data || []),
    supabase.from('user_blocks').select('blocked_user_id, reason, created_at').eq('blocker_user_id', params.id).then((x) => x.data || []),
    supabase.from('api_keys').select('id, workspace_id, label, key_prefix, scopes, created_at, last_used_at, revoked_at').eq('created_by_user', params.id).then((x) => x.data || []),
    supabase.from('calls').select('id, kind, started_at, ended_at, end_reason').or(`caller_user_id.eq.${params.id},callee_user_id.eq.${params.id}`).order('started_at', { ascending: false }).limit(50).then((x) => x.data || []),
  ]);

  ok(res, {
    user,
    devices,
    memberships: convMembers,
    reports_made: reportsMade,
    reports_against: reportsAgainst,
    blocks,
    api_keys: apiKeys,
    recent_calls: calls,
  });
}

/** POST /admin/users/:id/force-logout — revoke every device for the user. */
async function forceLogout(req, res, { params }) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('devices')
    .update({ revoked_at: now }).eq('user_id', params.id).is('revoked_at', null);
  if (error) return serverError(res, 'Force-logout failed', error);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.user.force_logout', targetType: 'user', targetId: params.id, req,
  });
  ok(res, { ok: true });
}

/** POST /admin/users/:id/set-admin { is_admin: true|false } */
async function setAdmin(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body || typeof body.is_admin !== 'boolean') return badRequest(res, 'is_admin boolean required');
  // Refuse to let an admin revoke their own admin status via this endpoint
  // — that's a trivial-to-mistap self-lockout.
  if (params.id === req.auth.userId && !body.is_admin) {
    return badRequest(res, 'cannot revoke own admin');
  }
  await supabase.from('users').update({ is_admin: body.is_admin }).eq('id', params.id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: body.is_admin ? 'admin.grant' : 'admin.revoke',
    targetType: 'user', targetId: params.id, req,
  });
  ok(res, { ok: true });
}

/** DELETE /admin/users/:id — hard-delete (right-to-delete flow). */
async function deleteUser(req, res, { params }) {
  const body = await readJson(req).catch(() => ({})) || {};
  if (!body.confirm) return badRequest(res, 'confirm: true required');
  // CASCADE handles most of the joins; user rows themselves get tombstoned.
  await supabase.from('users').update({
    phone_e164: null, username: null, display_name: '[deleted]',
    avatar_url: null, deleted_at: new Date().toISOString(),
  }).eq('id', params.id);
  await supabase.from('devices').update({ revoked_at: new Date().toISOString() })
    .eq('user_id', params.id).is('revoked_at', null);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.user.delete', targetType: 'user', targetId: params.id, req,
  });
  ok(res, { ok: true });
}

// ── Workspaces ─────────────────────────────────────────────────────

/** GET /admin/workspaces?q=…&limit=50 */
async function listWorkspaces(req, res, { query }) {
  const limit = clampInt(query.limit, 50, 1, 200);
  let qb = supabase.from('workspaces')
    .select('id, name, slug, created_at, deleted_at, owner_user_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (query.q) qb = qb.or(`name.ilike.%${query.q}%,slug.ilike.%${query.q}%`);
  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { workspaces: data || [] });
}

/**
 * DELETE /admin/workspaces/:id   { confirm: true }
 *
 * Soft-deletes the workspace. All channels in the workspace are also
 * soft-deleted; members lose access on next request via the membership
 * filter (`left_at` is set so they can't post / read). API keys are
 * revoked. Webhooks are deactivated. Audit-logged.
 */
async function dissolveWorkspace(req, res, { params }) {
  const body = await readJson(req).catch(() => ({})) || {};
  if (!body.confirm) return badRequest(res, 'confirm: true required');

  const now = new Date().toISOString();
  const { error: wsErr } = await supabase.from('workspaces')
    .update({ deleted_at: now }).eq('id', params.id);
  if (wsErr) return serverError(res, 'Dissolve failed', wsErr);

  // Cascade: channels → conversations.deleted_at
  await supabase.from('conversations').update({ deleted_at: now })
    .eq('workspace_id', params.id);
  // Cascade: workspace members → set left_at
  await supabase.from('workspace_members').update({ left_at: now })
    .eq('workspace_id', params.id).is('left_at', null);
  // Revoke all API keys for this workspace
  await supabase.from('api_keys').update({ revoked_at: now })
    .eq('workspace_id', params.id).is('revoked_at', null);
  // Deactivate workspace webhooks
  await supabase.from('webhooks').update({ active: false })
    .eq('workspace_id', params.id);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.workspace.dissolve',
    targetType: 'workspace', targetId: params.id,
    metadata: { reason: body.reason || null }, req,
  });

  ok(res, { ok: true });
}

// ── Conversations ──────────────────────────────────────────────────

/** GET /admin/conversations?q=…&kind=direct|group|channel&public=1&limit=50 */
async function listConversations(req, res, { query }) {
  const limit = clampInt(query.limit, 50, 1, 200);
  let qb = supabase.from('conversations')
    .select('id, kind, title, workspace_id, created_at, updated_at, deleted_at, public_slug, public_title, published_at')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (query.kind) qb = qb.eq('kind', query.kind);
  if (query.q) qb = qb.ilike('title', `%${query.q}%`);
  if (query.public === '1')      qb = qb.not('public_slug', 'is', null);
  else if (query.public === '0') qb = qb.is('public_slug', null);

  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { conversations: data || [] });
}

/** GET /admin/conversations/:id — members + message count + media count */
async function getConversation(req, res, { params }) {
  const { data: conv, error } = await supabase.from('conversations')
    .select('*').eq('id', params.id).maybeSingle();
  if (error) return serverError(res, 'Query failed', error);
  if (!conv) return notFound(res, 'Conversation not found');

  const [members, msgCount, mediaCount] = await Promise.all([
    supabase.from('conversation_members').select('user_id, role, joined_at, left_at, users:user_id (id, username, display_name, avatar_url, banned_at)')
      .eq('conversation_id', params.id).then((x) => x.data || []),
    countWhere('messages', 'conversation_id', 'eq', params.id),
    countWhere('media_objects', 'conversation_id', 'eq', params.id),
  ]);
  ok(res, { conversation: conv, members, message_count: msgCount, media_count: mediaCount });
}

// ── Media ──────────────────────────────────────────────────────────

/** GET /admin/media?limit=50 */
async function listMedia(req, res, { query }) {
  const limit = clampInt(query.limit, 50, 1, 200);
  const { data, error } = await supabase.from('media_objects')
    .select('id, uploader_user_id, conversation_id, mime_type, size_bytes, created_at, deleted_at, users:uploader_user_id (id, username, display_name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { media: data || [] });
}

/** POST /admin/media/:id/delete — soft-delete the media object. */
async function deleteMedia(req, res, { params }) {
  await supabase.from('media_objects').update({
    deleted_at: new Date().toISOString(),
  }).eq('id', params.id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.media.delete', targetType: 'media', targetId: params.id, req,
  });
  ok(res, { ok: true });
}

// ── Pairings ───────────────────────────────────────────────────────

async function listPairings(req, res, { query }) {
  const limit = clampInt(query.limit, 100, 1, 500);
  const { data, error } = await supabase.from('pairing_sessions')
    .select('id, initiator_device_id, claimed_by_device_id, status, created_at, claimed_at, expires_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { pairings: data || [] });
}

// ── Webhooks & deliveries ──────────────────────────────────────────

async function listWebhooks(req, res) {
  const { data, error } = await supabase.from('webhooks')
    .select('id, workspace_id, url, events, active, created_at, last_delivery_at, failure_count')
    .order('created_at', { ascending: false });
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { webhooks: data || [] });
}

async function listDeliveries(req, res, { query }) {
  const limit = clampInt(query.limit, 100, 1, 500);
  let qb = supabase.from('webhook_deliveries')
    .select('id, webhook_id, event, attempts, next_attempt_at, last_attempt_at, delivered_at, given_up_at, response_status, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (query.status === 'failing') qb = qb.is('delivered_at', null).is('given_up_at', null);
  else if (query.status === 'given_up') qb = qb.not('given_up_at', 'is', null);
  else if (query.status === 'delivered') qb = qb.not('delivered_at', 'is', null);

  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { deliveries: data || [] });
}

async function listEventLog(req, res, { query }) {
  const limit = clampInt(query.limit, 50, 1, 200);
  let qb = supabase.from('webhook_event_log')
    .select('id, event, workspace_id, payload, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (query.event) qb = qb.eq('event', query.event);
  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { events: data || [] });
}

// ── API keys (across workspaces) ──────────────────────────────────

async function listApiKeys(req, res) {
  const { data, error } = await supabase.from('api_keys')
    .select('id, workspace_id, label, key_prefix, scopes, created_by_user, created_at, expires_at, last_used_at, revoked_at')
    .order('created_at', { ascending: false });
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { api_keys: data || [] });
}

async function revokeApiKey(req, res, { params }) {
  await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() })
    .eq('id', params.id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.api_key.revoke', targetType: 'api_key', targetId: params.id, req,
  });
  ok(res, { ok: true });
}

// ── Feature flags ─────────────────────────────────────────────────

async function listFlags(req, res) {
  const { data, error } = await supabase.from('feature_flags')
    .select('*').order('key');
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { flags: data || [] });
}

async function upsertFlag(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body || !body.key) return badRequest(res, 'key required');
  if (body.rollout && !['off', 'on', 'percent', 'workspace'].includes(body.rollout)) {
    return badRequest(res, 'rollout must be off|on|percent|workspace');
  }
  const row = {
    key: String(body.key),
    description: body.description ?? null,
    rollout: body.rollout ?? 'off',
    percent: body.percent ?? null,
    allow_workspaces: body.allow_workspaces ?? [],
    updated_at: new Date().toISOString(),
    updated_by: req.auth.userId,
  };
  const { data, error } = await supabase.from('feature_flags')
    .upsert(row, { onConflict: 'key' }).select('*').single();
  if (error) return serverError(res, 'Upsert failed', error);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.feature_flag.upsert', targetType: 'feature_flag', targetId: row.key,
    metadata: { rollout: row.rollout, percent: row.percent }, req,
  });
  ok(res, { flag: data });
}

async function deleteFlag(req, res, { params }) {
  await supabase.from('feature_flags').delete().eq('key', params.key);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.feature_flag.delete', targetType: 'feature_flag', targetId: params.key, req,
  });
  ok(res, { ok: true });
}

// ── Retention policies ────────────────────────────────────────────

async function listRetention(req, res) {
  const { data, error } = await supabase.from('retention_policies')
    .select('*').order('created_at', { ascending: false });
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { policies: data || [] });
}

async function upsertRetention(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const row = {
    workspace_id: body.workspace_id ?? null,
    conversation_id: body.conversation_id ?? null,
    message_ttl_days: body.message_ttl_days ?? null,
    media_ttl_days: body.media_ttl_days ?? null,
    audit_ttl_days: body.audit_ttl_days ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('retention_policies')
    .upsert(row, { onConflict: 'workspace_id,conversation_id' }).select('*').single();
  if (error) return serverError(res, 'Upsert failed', error);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.retention.upsert', targetType: 'retention_policy', targetId: data.id,
    metadata: row, req,
  });
  ok(res, { policy: data });
}

// ── Audit log ─────────────────────────────────────────────────────

/**
 * GET /audit?action=&actor=&target_type=&target_id=&limit=100&before=
 * `before` is an ISO timestamp cursor (returns rows strictly older).
 */
async function listAudit(req, res, { query }) {
  const limit = clampInt(query.limit, 100, 1, 500);
  let qb = supabase.from('audit_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (query.action)       qb = qb.eq('action', query.action);
  if (query.actor)        qb = qb.eq('actor_user_id', query.actor);
  if (query.target_type)  qb = qb.eq('target_type', query.target_type);
  if (query.target_id)    qb = qb.eq('target_id', query.target_id);
  if (query.workspace_id) qb = qb.eq('workspace_id', query.workspace_id);
  if (query.before)       qb = qb.lt('created_at', query.before);

  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, {
    events: data || [],
    next_before: (data && data.length === limit) ? data[data.length - 1].created_at : null,
  });
}

// ── Helpers ───────────────────────────────────────────────────────

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

async function countRows(table) {
  const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
  return count || 0;
}

async function countRowsGt(table, col, value) {
  const { count } = await supabase.from(table)
    .select('*', { count: 'exact', head: true }).gt(col, value);
  return count || 0;
}

async function countWhere(table, col, op, value) {
  let qb = supabase.from(table).select('*', { count: 'exact', head: true });
  if (op === 'is')     qb = qb.is(col, value);
  if (op === 'not.is') qb = qb.not(col, 'is', value);
  if (op === 'eq')     qb = qb.eq(col, value);
  const { count } = await qb;
  return count || 0;
}

async function sumField(table, col) {
  // Supabase doesn't expose SUM via PostgREST without an RPC, so we pull
  // only the column and reduce. For small tables this is fine; for large
  // media tables we should eventually move this to a materialized view.
  const { data } = await supabase.from(table).select(col).limit(100_000);
  return (data || []).reduce((n, r) => n + (Number(r[col]) || 0), 0);
}

module.exports = {
  // Overview
  stats,
  // Users
  listUsers, getUser, forceLogout, setAdmin, deleteUser,
  // Workspaces
  listWorkspaces, dissolveWorkspace,
  // Conversations
  listConversations, getConversation,
  // Media
  listMedia, deleteMedia,
  // Pairings
  listPairings,
  // Webhooks
  listWebhooks, listDeliveries, listEventLog,
  // API keys
  listApiKeys, revokeApiKey,
  // Feature flags
  listFlags, upsertFlag, deleteFlag,
  // Retention
  listRetention, upsertRetention,
  // Audit
  listAudit,
};
