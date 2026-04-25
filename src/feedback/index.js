'use strict';

/**
 * User-submitted feedback + admin triage endpoints.
 *
 *   POST   /feedback                         authed user submits
 *   GET    /admin/feedback                   admin list by status
 *   GET    /admin/feedback/:id               admin detail
 *   POST   /admin/feedback/:id/resolve       admin mark resolved / wontfix
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { hit, check, send429 } = require('../middleware/rateLimit');

const ALLOWED_CATEGORIES = ['bug', 'feature', 'praise', 'ux', 'security', 'other'];

async function submit(req, res) {
  // 20 feedback entries per user per day keeps the form from being abused.
  const key = `fb:u:${req.auth.userId}`;
  if (!check(key, 20, 86_400)) return send429(res);
  hit(key);

  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const category = String(body.category || '').toLowerCase();
  if (!ALLOWED_CATEGORIES.includes(category)) return badRequest(res, 'Invalid category');

  const text = String(body.body || '').trim();
  if (!text) return badRequest(res, 'body required');
  if (text.length > 5000) return badRequest(res, 'body too long (max 5000)');

  const row = {
    user_id: req.auth.userId,
    category,
    body: text,
    screenshot_media_id: body.screenshot_media_id || null,
    platform: body.platform ? String(body.platform).slice(0, 32) : null,
    app_version: body.app_version ? String(body.app_version).slice(0, 32) : null,
  };
  const { data, error } = await supabase.from('feedback').insert(row).select('*').single();
  if (error) return serverError(res, 'Submit failed', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'feedback.submit', targetType: 'feedback', targetId: data.id,
    metadata: { category }, req,
  });

  created(res, { feedback: { id: data.id, category: data.category, created_at: data.created_at } });
}

async function adminList(req, res, { query }) {
  const status = query.status || 'new';
  const category = query.category || null;
  const limit = Math.max(1, Math.min(200, Number(query.limit) || 100));

  let qb = supabase.from('feedback')
    .select('id, user_id, category, body, screenshot_media_id, platform, app_version, status, resolution_note, resolved_by, resolved_at, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status !== 'all') qb = qb.eq('status', status);
  if (category)         qb = qb.eq('category', category);

  const { data, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { feedback: data || [] });
}

async function adminGet(req, res, { params }) {
  const { data: f } = await supabase.from('feedback').select('*').eq('id', params.id).maybeSingle();
  if (!f) return notFound(res);
  const { data: user } = f.user_id
    ? await supabase.from('users').select('id, username, display_name, phone_e164, banned_at').eq('id', f.user_id).maybeSingle()
    : { data: null };
  ok(res, { feedback: f, user });
}

async function adminResolve(req, res, { params }) {
  const body = await readJson(req).catch(() => ({})) || {};
  const status = ['new', 'triaged', 'resolved', 'wontfix'].includes(body.status) ? body.status : 'resolved';

  const { data, error } = await supabase.from('feedback').update({
    status,
    resolution_note: body.resolution_note ? String(body.resolution_note).slice(0, 2000) : null,
    resolved_by: req.auth.userId,
    resolved_at: new Date().toISOString(),
  }).eq('id', params.id).select('*').single();
  if (error) return serverError(res, 'Update failed', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: `feedback.${status}`, targetType: 'feedback', targetId: params.id,
    metadata: { note: body.resolution_note || null }, req,
  });

  ok(res, { feedback: data });
}

module.exports = { submit, adminList, adminGet, adminResolve };
