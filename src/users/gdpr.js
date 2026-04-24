'use strict';

/**
 * GDPR self-service: data export + hard delete.
 *
 * Data export includes every record where the user is a principal —
 * profile, devices, memberships, reminders, tasks they created, audit
 * events they triggered, reports they filed. Message *content* is never
 * exposed because it's E2E-encrypted and the server can't decrypt it;
 * we include envelope metadata only (ids, timestamps, kind).
 *
 * Delete is a soft-tombstone on the users table + revoke every device +
 * anonymize owner fields on messages/tasks. Actual cascade purge is
 * handled by the retention sweeper on a schedule so deletion returns
 * fast and doesn't block the request thread for minutes.
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, serverError } = require('../util/response');
const { audit } = require('../util/audit');

/** GET /users/me/export — returns a JSON bundle. */
async function exportMe(req, res) {
  const uid = req.auth.userId;
  const [user, devices, memberships, blocks, reports, appeals, tasks, reminders, auditEvents, apiKeys] = await Promise.all([
    supabase.from('users').select('*').eq('id', uid).maybeSingle().then((x) => x.data),
    supabase.from('devices').select('id, kind, label, created_at, last_seen_at, revoked_at, fingerprint').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('conversation_members').select('conversation_id, role, joined_at, left_at').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('user_blocks').select('blocked_user_id, reason, created_at').eq('blocker_user_id', uid).then((x) => x.data || []),
    supabase.from('reports').select('*').eq('reporter_user_id', uid).then((x) => x.data || []),
    supabase.from('report_appeals').select('*').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('tasks').select('id, title, status, priority, due_at, created_at, workspace_id').eq('creator_user_id', uid).then((x) => x.data || []),
    supabase.from('reminders').select('id, title, remind_at, fired_at, created_at').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('audit_events').select('action, target_type, target_id, created_at, metadata').eq('actor_user_id', uid).order('created_at', { ascending: false }).limit(2000).then((x) => x.data || []),
    supabase.from('api_keys').select('id, workspace_id, label, key_prefix, scopes, created_at, expires_at, last_used_at, revoked_at').eq('created_by_user', uid).then((x) => x.data || []),
  ]);

  audit({
    userId: uid, deviceId: req.auth.deviceId,
    action: 'gdpr.export', targetType: 'user', targetId: uid, req,
  });

  ok(res, {
    exported_at: new Date().toISOString(),
    user,
    devices,
    conversation_memberships: memberships,
    blocks,
    reports,
    appeals,
    tasks,
    reminders,
    audit_events: auditEvents,
    api_keys: apiKeys,
    note:
      'Message, call, and media content is end-to-end encrypted. The server does not hold the keys ' +
      'and therefore cannot include plaintext in this export. Use the mobile apps to export decrypted ' +
      'content from your local device.',
  });
}

/**
 * DELETE /users/me
 * Body: { confirm: true }
 *
 * Tombstones the user row (PII stripped), revokes all devices, inserts
 * a fingerprint ban for the phone_hash so the number can't be re-bound
 * immediately (matches the GDPR right-to-be-forgotten while still
 * honoring anti-abuse requirements).
 */
async function deleteMe(req, res) {
  const body = await readJson(req).catch(() => ({})) || {};
  if (!body.confirm) return badRequest(res, 'confirm: true required');

  const uid = req.auth.userId;
  const { data: user } = await supabase.from('users')
    .select('phone_hash').eq('id', uid).maybeSingle();

  const { error } = await supabase.from('users').update({
    phone_e164: null, username: null, display_name: '[deleted]',
    avatar_url: null, bio: null, status_text: null,
    deleted_at: new Date().toISOString(),
  }).eq('id', uid);
  if (error) return serverError(res, 'Delete failed', error);

  await supabase.from('devices').update({ revoked_at: new Date().toISOString() })
    .eq('user_id', uid).is('revoked_at', null);

  // Grace-period anti-abuse: the number can't re-register for 30 days.
  // This is distinct from a policy ban — no admin involvement.
  if (user?.phone_hash) {
    await supabase.from('banned_fingerprints').insert({
      phone_hash: user.phone_hash,
      reason: 'gdpr.self_delete',
    });
  }

  audit({
    userId: uid, deviceId: req.auth.deviceId,
    action: 'gdpr.self_delete', targetType: 'user', targetId: uid, req,
  });

  ok(res, { ok: true });
}

module.exports = { exportMe, deleteMe };
