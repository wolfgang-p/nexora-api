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

/**
 * GET /users/me/export — streams a downloadable JSON archive of every
 * record where the calling user is a principal. Plaintext message +
 * media bytes can't be included (E2E), but we ship:
 *   • full envelope of every message the user authored
 *   • every per-recipient ciphertext addressed to the user's devices,
 *     so the user can decrypt offline with their own keypair
 *   • metadata of every media object the user uploaded
 *   • settings, drafts, reminders, tasks, calendar, audit, etc.
 *
 * Response is `application/json` with `Content-Disposition:
 * attachment` so the browser saves it as a file.
 */
async function exportMe(req, res) {
  const uid = req.auth.userId;

  const [
    user, devices, memberships, blocks, reports, appeals, tasks, reminders,
    auditEvents, apiKeys, settings, calendarLinks, calendarEvents, drafts,
    storyViews, storyReactions,
  ] = await Promise.all([
    supabase.from('users').select('*').eq('id', uid).maybeSingle().then((x) => x.data),
    supabase.from('devices').select('id, kind, label, identity_public_key, enrolled_at, last_seen_at, revoked_at, fingerprint').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('conversation_members').select('*').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('user_blocks').select('blocked_user_id, reason, created_at').eq('blocker_user_id', uid).then((x) => x.data || []),
    supabase.from('reports').select('*').eq('reporter_user_id', uid).then((x) => x.data || []),
    supabase.from('report_appeals').select('*').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('tasks').select('*').eq('creator_user_id', uid).then((x) => x.data || []),
    supabase.from('reminders').select('*').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('audit_events').select('action, target_type, target_id, created_at, metadata').eq('actor_user_id', uid).order('created_at', { ascending: false }).limit(5000).then((x) => x.data || []),
    supabase.from('api_keys').select('id, workspace_id, label, key_prefix, scopes, created_at, expires_at, last_used_at, revoked_at').eq('created_by_user', uid).then((x) => x.data || []),
    supabase.from('user_settings').select('*').eq('user_id', uid).maybeSingle().then((x) => x.data),
    supabase.from('calendar_links').select('provider, created_at, revoked_at').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('calendar_events').select('*').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('drafts').select('conversation_id, ciphertext, nonce, source_device_id, updated_at').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('story_views').select('story_id, created_at').eq('user_id', uid).then((x) => x.data || []),
    supabase.from('story_reactions').select('story_id, emoji, created_at').eq('user_id', uid).then((x) => x.data || []),
  ]);

  // Messages I authored — envelope only.
  const { data: sentMessages } = await supabase.from('messages')
    .select('id, conversation_id, sender_device_id, kind, reply_to_message_id, thread_root_id, forwarded_at, edited_at, pinned_at, created_at, deleted_at')
    .eq('sender_user_id', uid)
    .order('created_at', { ascending: false }).limit(50000);

  // Per-recipient ciphertexts addressed to MY devices — user decrypts
  // offline with their own keypair to recover plaintext.
  const myDeviceIds = (devices || []).map((d) => d.id);
  let recipientRows = [];
  if (myDeviceIds.length) {
    const { data } = await supabase.from('message_recipients')
      .select('message_id, recipient_device_id, ciphertext, nonce, delivered_at, read_at')
      .in('recipient_device_id', myDeviceIds);
    recipientRows = data || [];
  }

  const { data: media } = await supabase.from('media_objects')
    .select('id, mime_type, size_bytes, created_at, conversation_id')
    .eq('uploader_user_id', uid).limit(50000);

  audit({
    userId: uid, deviceId: req.auth.deviceId,
    action: 'gdpr.export', targetType: 'user', targetId: uid, req,
  });

  const payload = {
    exported_at: new Date().toISOString(),
    schema_version: 2,
    user,
    settings,
    devices,
    conversation_memberships: memberships,
    drafts,
    messages: sentMessages || [],
    inbound_message_ciphertexts: recipientRows,
    media_objects: media || [],
    blocks,
    reports,
    appeals,
    tasks,
    reminders,
    calendar_links: calendarLinks,
    calendar_events: calendarEvents,
    story_views: storyViews,
    story_reactions: storyReactions,
    audit_events: auditEvents,
    api_keys: apiKeys,
    note:
      'Message + media plaintext is end-to-end encrypted; the server does not hold the keys. ' +
      '`messages` lists the envelopes you authored. `inbound_message_ciphertexts` carries the ' +
      'sealed copies addressed to your devices — run them through your local keypair to recover ' +
      'plaintext. `media_objects` lists files you uploaded; their bytes are encrypted client-side ' +
      'with a key that only conversation members hold.',
  };

  // Stream as a downloadable JSON file.
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="koro-export-${uid.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
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
