'use strict';

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, notFound, forbidden, serverError } = require('../util/response');
const { audit } = require('../util/audit');

/**
 * GET /reminders?window=upcoming|past|all
 */
async function list(req, res, { query }) {
  const window = query.window || 'upcoming';
  let q = supabase.from('reminders')
    .select('*')
    .eq('user_id', req.auth.userId);

  if (window === 'upcoming') {
    q = q.is('fired_at', null).is('dismissed_at', null).order('remind_at', { ascending: true });
  } else if (window === 'past') {
    q = q.not('fired_at', 'is', null).order('fired_at', { ascending: false });
  } else {
    q = q.order('remind_at', { ascending: false });
  }
  q = q.limit(200);

  const { data, error } = await q;
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { reminders: data || [] });
}

/**
 * POST /reminders
 *   { title, body?, remind_at, task_id?, conversation_id?, message_id? }
 */
async function create(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.title || !body?.remind_at) {
    return badRequest(res, 'title and remind_at required');
  }
  const when = new Date(body.remind_at);
  if (Number.isNaN(when.getTime())) return badRequest(res, 'invalid remind_at');
  // Allow past dates up to 5 min — clock skew tolerance; beyond that, nope.
  if (when.getTime() < Date.now() - 5 * 60 * 1000) {
    return badRequest(res, 'remind_at is in the past');
  }
  if (when.getTime() > Date.now() + 365 * 2 * 86400_000) {
    return badRequest(res, 'remind_at > 2 years away');
  }

  const row = {
    user_id: req.auth.userId,
    title: String(body.title).slice(0, 200),
    body: body.body ? String(body.body).slice(0, 1000) : null,
    remind_at: when.toISOString(),
    task_id: body.task_id || null,
    conversation_id: body.conversation_id || null,
    message_id: body.message_id || null,
  };

  const { data, error } = await supabase.from('reminders').insert(row).select('*').single();
  if (error) return serverError(res, 'Create failed', error);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'reminder.create', targetType: 'reminder', targetId: data.id,
    metadata: { remind_at: row.remind_at }, req,
  });
  created(res, { reminder: data });
}

/**
 * PUT /reminders/:id   { title?, body?, remind_at?, dismissed?, snoozed_until? }
 */
async function update(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const { data: r } = await supabase.from('reminders').select('*')
    .eq('id', params.id).eq('user_id', req.auth.userId).maybeSingle();
  if (!r) return notFound(res, 'Reminder not found');

  const patch = {};
  if (body.title !== undefined) patch.title = String(body.title).slice(0, 200);
  if (body.body !== undefined) patch.body = body.body ? String(body.body).slice(0, 1000) : null;
  if (body.remind_at !== undefined) {
    const d = new Date(body.remind_at);
    if (Number.isNaN(d.getTime())) return badRequest(res, 'invalid remind_at');
    patch.remind_at = d.toISOString();
    patch.fired_at = null; // rescheduling reopens it
  }
  if (body.dismissed === true) patch.dismissed_at = new Date().toISOString();
  if (body.snoozed_until !== undefined) {
    const d = new Date(body.snoozed_until);
    if (Number.isNaN(d.getTime())) return badRequest(res, 'invalid snoozed_until');
    patch.snoozed_until = d.toISOString();
    patch.fired_at = null;
    patch.remind_at = d.toISOString();
  }

  const { data, error } = await supabase.from('reminders').update(patch)
    .eq('id', params.id).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { reminder: data });
}

/** DELETE /reminders/:id */
async function destroy(req, res, { params }) {
  const { error } = await supabase.from('reminders').delete()
    .eq('id', params.id).eq('user_id', req.auth.userId);
  if (error) return serverError(res, 'Delete failed', error);
  ok(res, { ok: true });
}

module.exports = { list, create, update, destroy };
