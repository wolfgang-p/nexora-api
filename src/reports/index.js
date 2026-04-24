'use strict';

/**
 * User-facing report creation + admin moderation queue.
 *
 *   POST   /reports                        (any authed user)
 *   GET    /admin/reports                  (admin)
 *   GET    /admin/reports/:id              (admin)
 *   POST   /admin/reports/:id/resolve      (admin)
 *   POST   /admin/appeals                  (authed user — contest a ban)
 *   GET    /admin/appeals                  (admin)
 *   POST   /admin/appeals/:id/resolve      (admin)
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { hit, check, send429, clientIp } = require('../middleware/rateLimit');

const ALLOWED_REASONS = ['spam', 'harassment', 'csam', 'illegal', 'impersonation', 'other'];

/** POST /reports — reporter is req.auth.userId */
async function createReport(req, res) {
  // Prevent abuse of the reporting system itself: 10 reports per user per hour.
  const key = `report:u:${req.auth.userId}`;
  if (!check(key, 10, 3600)) return send429(res);
  hit(key);

  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const reason = String(body.reason || '').toLowerCase();
  if (!ALLOWED_REASONS.includes(reason)) return badRequest(res, 'Invalid reason');

  const details = body.details ? String(body.details).slice(0, 2000) : null;

  const row = {
    reporter_user_id: req.auth.userId,
    target_message_id: body.message_id || null,
    target_user_id: body.user_id || null,
    target_conversation_id: body.conversation_id || null,
    reason,
    details,
  };

  if (!row.target_message_id && !row.target_user_id && !row.target_conversation_id) {
    return badRequest(res, 'at least one of message_id / user_id / conversation_id required');
  }

  // Self-report guard
  if (row.target_user_id && row.target_user_id === req.auth.userId) {
    return badRequest(res, 'cannot report yourself');
  }

  const { data, error } = await supabase.from('reports').insert(row).select('*').single();
  if (error) return serverError(res, 'Report failed', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'report.create', targetType: 'report', targetId: data.id,
    metadata: { reason, target_message_id: row.target_message_id, target_user_id: row.target_user_id },
    req,
  });

  created(res, { report: data });
}

/** GET /admin/reports?status=pending|reviewed|dismissed|actioned&limit=50&cursor= */
async function adminListReports(req, res, { query }) {
  const status = query.status || 'pending';
  const limit = clampInt(query.limit, 50, 1, 200);

  const { data, error } = await supabase.from('reports')
    .select(`
      id, reason, details, status, resolution,
      reporter_user_id, target_user_id, target_message_id, target_conversation_id,
      resolved_by, resolved_at, created_at
    `)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return serverError(res, 'Query failed', error);
  ok(res, { reports: data || [] });
}

/** GET /admin/reports/:id — fully hydrated view with reporter + target metadata. */
async function adminGetReport(req, res, { params }) {
  const { data: r, error } = await supabase.from('reports')
    .select('*').eq('id', params.id).maybeSingle();
  if (error) return serverError(res, 'Query failed', error);
  if (!r) return notFound(res, 'Report not found');

  const hydrated = await hydrateReport(r);
  ok(res, { report: hydrated });
}

async function hydrateReport(r) {
  const [reporter, target, conv, msg] = await Promise.all([
    r.reporter_user_id
      ? supabase.from('users').select('id, username, display_name, phone_e164, banned_at').eq('id', r.reporter_user_id).maybeSingle().then((x) => x.data)
      : null,
    r.target_user_id
      ? supabase.from('users').select('id, username, display_name, phone_e164, banned_at, is_admin, created_at').eq('id', r.target_user_id).maybeSingle().then((x) => x.data)
      : null,
    r.target_conversation_id
      ? supabase.from('conversations').select('id, kind, title, created_at').eq('id', r.target_conversation_id).maybeSingle().then((x) => x.data)
      : null,
    r.target_message_id
      ? supabase.from('messages').select('id, conversation_id, sender_user_id, kind, created_at, deleted_at').eq('id', r.target_message_id).maybeSingle().then((x) => x.data)
      : null,
  ]);
  return { ...r, reporter, target_user: target, target_conversation: conv, target_message: msg };
}

/**
 * POST /admin/reports/:id/resolve
 *
 * Body: {
 *   action: 'dismiss' | 'warn' | 'delete_message' | 'ban_user' | 'mute_user',
 *   resolution?: string,             // admin note
 *   ban_reason?: string,             // when action=ban_user
 *   mute_duration_hours?: number,    // when action=mute_user
 * }
 */
async function adminResolveReport(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const action = body.action;
  if (!['dismiss', 'warn', 'delete_message', 'ban_user', 'mute_user', 'no_action'].includes(action)) {
    return badRequest(res, 'Invalid action');
  }

  const { data: report, error: rErr } = await supabase.from('reports')
    .select('*').eq('id', params.id).maybeSingle();
  if (rErr) return serverError(res, 'Query failed', rErr);
  if (!report) return notFound(res, 'Report not found');

  const status = action === 'dismiss' ? 'dismissed'
    : action === 'no_action' ? 'reviewed'
    : 'actioned';

  // Execute the action FIRST — if the ban/delete fails, we don't want to
  // mark the report "actioned".
  if (action === 'delete_message' && report.target_message_id) {
    await supabase.from('messages').update({
      deleted_at: new Date().toISOString(),
      kind: 'deleted',
    }).eq('id', report.target_message_id);
  }

  if (action === 'ban_user' && report.target_user_id) {
    const banRes = await banUser({
      userId: report.target_user_id,
      reason: body.ban_reason || body.resolution || 'policy_violation',
      bannedBy: req.auth.userId,
    });
    if (banRes.error) return serverError(res, 'Ban failed', banRes.error);
  }

  if (action === 'mute_user' && report.target_user_id) {
    // Soft-mute: store an entry in a simple table-less convention — we
    // write it into the user row's metadata-ish field. For now we put a
    // banned_until in banned_reason until we add a real mutes table.
    const hours = Math.min(24 * 30, Math.max(1, Number(body.mute_duration_hours) || 24));
    const until = new Date(Date.now() + hours * 3600_000).toISOString();
    await supabase.from('users').update({
      banned_at: new Date().toISOString(),
      banned_reason: `muted_until:${until}`,
      banned_by: req.auth.userId,
    }).eq('id', report.target_user_id);
  }

  const { data: updated, error: uErr } = await supabase.from('reports').update({
    status,
    resolution: body.resolution || action,
    resolved_by: req.auth.userId,
    resolved_at: new Date().toISOString(),
  }).eq('id', params.id).select('*').single();
  if (uErr) return serverError(res, 'Update failed', uErr);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: `report.${action}`, targetType: 'report', targetId: params.id,
    metadata: { report: report.id, target_user: report.target_user_id, target_message: report.target_message_id },
    req,
  });

  ok(res, { report: updated });
}

/**
 * Ban a user. Revokes all their devices (force-logout), sets banned_at,
 * and records their phone_hash + every device identity_public_key in the
 * fingerprint blocklist so re-registration can reject them.
 */
async function banUser({ userId, reason, bannedBy }) {
  const { data: user, error: uErr } = await supabase.from('users')
    .select('id, phone_hash').eq('id', userId).maybeSingle();
  if (uErr) return { error: uErr };
  if (!user) return { error: new Error('User not found') };

  await supabase.from('users').update({
    banned_at: new Date().toISOString(),
    banned_reason: reason,
    banned_by: bannedBy,
  }).eq('id', userId);

  // Force-logout every device.
  await supabase.from('devices').update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId).is('revoked_at', null);

  // Record fingerprints so re-registration is blocked even after data deletion.
  const { data: devs } = await supabase.from('devices')
    .select('identity_public_key').eq('user_id', userId);

  const rows = [];
  if (user.phone_hash) {
    rows.push({ phone_hash: user.phone_hash, reason, banned_by: bannedBy });
  }
  for (const d of devs || []) {
    if (d.identity_public_key) {
      rows.push({ device_public_key: d.identity_public_key, reason, banned_by: bannedBy });
    }
  }
  if (rows.length > 0) {
    await supabase.from('banned_fingerprints').insert(rows);
  }

  return { ok: true };
}

/** POST /admin/users/:id/ban */
async function adminBanUser(req, res, { params }) {
  const body = await readJson(req).catch(() => ({})) || {};
  const reason = String(body.reason || 'policy_violation').slice(0, 500);
  const r = await banUser({ userId: params.id, reason, bannedBy: req.auth.userId });
  if (r.error) return serverError(res, 'Ban failed', r.error);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.user.ban', targetType: 'user', targetId: params.id,
    metadata: { reason }, req,
  });
  ok(res, { ok: true });
}

/** DELETE /admin/users/:id/ban — lift the ban; fingerprints remain until cleared via appeals. */
async function adminUnbanUser(req, res, { params }) {
  await supabase.from('users').update({
    banned_at: null, banned_reason: null, banned_by: null,
  }).eq('id', params.id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'admin.user.unban', targetType: 'user', targetId: params.id, req,
  });
  ok(res, { ok: true });
}

/** POST /admin/appeals — user appeals a ban or a report action. */
async function createAppeal(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body || !body.message) return badRequest(res, 'message required');

  const row = {
    user_id: req.auth.userId,
    report_id: body.report_id || null,
    ban_ref: body.ban_ref || null,
    message: String(body.message).slice(0, 4000),
  };
  const { data, error } = await supabase.from('report_appeals').insert(row).select('*').single();
  if (error) return serverError(res, 'Appeal failed', error);
  created(res, { appeal: data });
}

async function adminListAppeals(req, res, { query }) {
  const status = query.status || 'pending';
  const { data, error } = await supabase.from('report_appeals')
    .select('*').eq('status', status).order('created_at', { ascending: false }).limit(100);
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { appeals: data || [] });
}

async function adminResolveAppeal(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const resolution = body.status === 'accepted' ? 'accepted' : 'rejected';
  const { data, error } = await supabase.from('report_appeals').update({
    status: resolution,
    admin_response: body.response ? String(body.response).slice(0, 4000) : null,
    resolved_at: new Date().toISOString(),
  }).eq('id', params.id).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: `appeal.${resolution}`, targetType: 'appeal', targetId: params.id, req,
  });
  ok(res, { appeal: data });
}

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

module.exports = {
  createReport,
  adminListReports, adminGetReport, adminResolveReport,
  adminBanUser, adminUnbanUser,
  createAppeal, adminListAppeals, adminResolveAppeal,
  banUser,
};
