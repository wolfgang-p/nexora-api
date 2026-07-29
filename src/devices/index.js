'use strict';

const { supabase } = require('../db/supabase');
const { ok, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { disconnectDevice } = require('../ws/dispatch');

/**
 * GET /devices   (self)
 */
async function listOwnDevices(req, res) {
  // `identity_public_key` is needed so the story composer can include
  // the user's own other devices as recipients of their story (so the
  // story is visible across all of their logins). Without it, the
  // client tries to b64-decode `undefined` and throws "Invalid encoding".
  const { data: devices } = await supabase
    .from('devices')
    .select('id, kind, label, fingerprint, identity_public_key, enrolled_at, last_seen_at, revoked_at, user_agent, location_hint')
    .eq('user_id', req.auth.userId)
    .order('enrolled_at', { ascending: false });
  ok(res, { devices: devices || [] });
}

/**
 * GET /conversations/:id/devices
 * Used by a sender to build the fanout list. Returns devices + public keys for
 * every active member of the conversation (the caller must be a member).
 */
async function listConversationDevices(req, res, { params }) {
  const { data: me } = await supabase
    .from('conversation_members').select('user_id')
    .eq('conversation_id', params.id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me) return forbidden(res, 'Not a member');

  const { data: members } = await supabase
    .from('conversation_members').select('user_id')
    .eq('conversation_id', params.id).is('left_at', null);
  const memberIds = (members || []).map((m) => m.user_id);
  if (memberIds.length === 0) return ok(res, { devices: [] });

  const { data: devs } = await supabase
    .from('devices')
    .select('id, user_id, kind, label, fingerprint, identity_public_key')
    .in('user_id', memberIds)
    .is('revoked_at', null);

  const out = (devs || []).map((d) => ({
    id: d.id,
    user_id: d.user_id,
    kind: d.kind,
    label: d.label,
    fingerprint: d.fingerprint,
    identity_public_key: d.identity_public_key,
  }));
  ok(res, { devices: out });
}

/**
 * DELETE /devices/:id   (self)
 */
async function revokeDevice(req, res, { params }) {
  const { data: device } = await supabase
    .from('devices').select('id, user_id, revoked_at').eq('id', params.id).maybeSingle();
  if (!device || device.user_id !== req.auth.userId) return notFound(res, 'Device not found');
  if (device.revoked_at) return ok(res, { ok: true });

  await supabase.from('devices').update({
    revoked_at: new Date().toISOString(),
    revoked_reason: 'user_revoked',
  }).eq('id', params.id);

  await supabase.from('sessions').update({ revoked_at: new Date().toISOString() })
    .eq('device_id', params.id).is('revoked_at', null);

  disconnectDevice(params.id);

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'device.revoke', targetType: 'device', targetId: params.id, req });

  ok(res, { ok: true });
}

/**
 * PUT /devices/:id   (self)  { label?, location_hint?, identity_public_key? }
 *
 * `identity_public_key` lets a device re-key itself onto the user's stable
 * identity key after a passphrase-backup restore: at login the device first
 * registers a fresh local key, then — once the backup is restored and the
 * shared user key adopted — it calls this to advertise the user key so peers
 * encrypt to it and its own fanout rows become decryptable. The fingerprint is
 * re-derived from the new key. Re-keying is only allowed onto a key already
 * used by another (non-revoked) device of the same user, so a device can't be
 * silently pointed at an attacker-chosen key.
 */
async function updateDevice(req, res, { params }) {
  const { readJson, badRequest } = require('../util/response');
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const { data: device } = await supabase
    .from('devices').select('id, user_id').eq('id', params.id).maybeSingle();
  if (!device || device.user_id !== req.auth.userId) return notFound(res, 'Device not found');

  const patch = {};
  if (body.label !== undefined) patch.label = body.label;
  if (body.location_hint !== undefined) patch.location_hint = body.location_hint;

  if (body.identity_public_key !== undefined) {
    const pubKeyB64 = String(body.identity_public_key || '');
    const pubKeyBuffer = Buffer.from(pubKeyB64, 'base64');
    if (pubKeyBuffer.length < 16 || pubKeyBuffer.length > 256) {
      return badRequest(res, 'identity_public_key has unreasonable length');
    }
    // Only allow re-keying onto a key already in use by one of this user's own
    // devices (revoked ones count — their rows persist and back the history
    // fallback) — i.e. the established user identity key recovered from the
    // passphrase backup. Prevents pointing a device at an arbitrary key.
    const { data: peer } = await supabase
      .from('devices')
      .select('id')
      .eq('user_id', req.auth.userId)
      .eq('identity_public_key', pubKeyB64)
      .neq('id', params.id)
      .limit(1)
      .maybeSingle();
    if (!peer) {
      return badRequest(res, 'identity_public_key must match an existing device of this user');
    }
    const { deviceFingerprint } = require('../util/crypto');
    patch.identity_public_key = pubKeyB64;
    patch.fingerprint = deviceFingerprint(pubKeyBuffer);
  }

  if (Object.keys(patch).length === 0) return ok(res, { ok: true });

  await supabase.from('devices').update(patch).eq('id', params.id);
  ok(res, { ok: true, fingerprint: patch.fingerprint });
}

/**
 * POST /devices/push-token   { token, platform? }
 * Registers / refreshes this device's Expo push token.
 */
async function registerPushToken(req, res) {
  const { readJson, badRequest } = require('../util/response');
  const body = await readJson(req).catch(() => null);
  if (!body?.token && !body?.voip_token) {
    return badRequest(res, 'token or voip_token required');
  }

  const deviceId = req.auth.deviceId;
  const platform = body.platform || req.headers['x-platform'] || 'unknown';

  // Update only the columns the client actually provided so a VoIP-only
  // registration (PushKit fires before the user grants notifications, so the
  // regular token may not exist yet) doesn't wipe the regular APNs/FCM token —
  // and vice-versa. We UPDATE an existing row or INSERT a new one explicitly,
  // rather than upsert(): a bare upsert with only { voip_token } tried to INSERT
  // a row with token=NULL and hit the NOT-NULL constraint (0034 relaxes that,
  // but this split also guarantees we never clobber the sibling token column).
  const fields = { platform, last_used_at: new Date().toISOString() };
  if (body.token)      fields.token = body.token;
  if (body.voip_token) fields.voip_token = body.voip_token;

  const { data: existing } = await supabase
    .from('push_tokens')
    .select('device_id')
    .eq('device_id', deviceId)
    .maybeSingle();

  const { error } = existing
    ? await supabase.from('push_tokens').update(fields).eq('device_id', deviceId)
    : await supabase.from('push_tokens').insert({ device_id: deviceId, ...fields });

  if (error) {
    console.error('[push-token] SAVE FAILED:', error.message);
    return serverError(res, 'Failed to save push token');
  }
  ok(res, { ok: true });
}

/**
 * POST /devices/:id/request-history   (self)
 *
 * A freshly linked device (e.g. the /koro web client) that finds it can't
 * decrypt old history stamps itself as "needs history sync". Another device of
 * the same user that CAN decrypt (the phone) later reads this and re-seals the
 * history to it (POST /messages/:id/recipients), then clears the stamp. The
 * caller may only stamp its OWN device.
 */
async function requestHistory(req, res, { params }) {
  const { data: device } = await supabase
    .from('devices').select('id, user_id').eq('id', params.id).maybeSingle();
  if (!device || device.user_id !== req.auth.userId) return notFound(res, 'Device not found');

  await supabase.from('devices')
    .update({ history_requested_at: new Date().toISOString() })
    .eq('id', params.id);
  ok(res, { ok: true });
}

/**
 * GET /devices/history-requests   (self)
 *
 * Returns this user's OWN devices that have a pending history request (other
 * than the caller itself), with their public keys — so the phone knows which
 * devices to re-seal history to.
 */
async function listHistoryRequests(req, res) {
  const { data: devices } = await supabase
    .from('devices')
    .select('id, label, identity_public_key, history_requested_at')
    .eq('user_id', req.auth.userId)
    .is('revoked_at', null)
    .not('history_requested_at', 'is', null)
    .neq('id', req.auth.deviceId);
  ok(res, { devices: devices || [] });
}

/**
 * DELETE /devices/:id/request-history   (self)
 * Clears the pending flag — called by the phone once it has synced history to
 * the target device.
 */
async function clearHistoryRequest(req, res, { params }) {
  const { data: device } = await supabase
    .from('devices').select('id, user_id').eq('id', params.id).maybeSingle();
  if (!device || device.user_id !== req.auth.userId) return notFound(res, 'Device not found');

  await supabase.from('devices')
    .update({ history_requested_at: null })
    .eq('id', params.id);
  ok(res, { ok: true });
}

/**
 * POST /devices/voip-selftest   (self)
 *
 * Fires a REAL incoming-call push (VoIP/PushKit if a voip_token is present,
 * else the regular high-priority call push) at ALL of the caller's OWN devices.
 * Lets a single user verify killed-app CallKit ringing end-to-end without a
 * second person. Returns a diagnostic breakdown so the client can show exactly
 * what happened (how many voip_tokens were targeted, APNs configured, etc.).
 */
async function voipSelfTest(req, res) {
  const { pushIncomingCall } = require('../push');

  // All of the caller's non-revoked devices.
  const { data: devices } = await supabase
    .from('devices')
    .select('id')
    .eq('user_id', req.auth.userId)
    .is('revoked_at', null);
  const deviceIds = (devices || []).map((d) => d.id);

  // How many of them actually carry a voip_token right now (the crux metric).
  const { data: voipRows } = await supabase
    .from('push_tokens')
    .select('device_id, voip_token')
    .in('device_id', deviceIds)
    .not('voip_token', 'is', null);
  const voipCount = (voipRows || []).length;

  const apnsConfigured = !!(
    process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID &&
    process.env.APNS_BUNDLE_ID &&
    (process.env.APNS_KEY_P8_BASE64 || process.env.APNS_KEY_P8)
  );

  // Fire the same path a real call uses. Best-effort; never throw at the client.
  const testCallId = `selftest-${req.auth.deviceId}-${Date.now()}`;
  try {
    await pushIncomingCall(deviceIds, {
      callId: testCallId,
      conversationId: 'selftest',
      kind: 'audio',
      fromName: 'Koro Selbsttest',
    });
  } catch (e) {
    console.error('[voip-selftest]', e?.message || e);
  }

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'devices.voip_selftest',
    metadata: { deviceIds: deviceIds.length, voipCount, apnsConfigured },
  });

  ok(res, {
    ok: true,
    devices: deviceIds.length,
    voip_tokens: voipCount,
    apns_configured: apnsConfigured,
    apns_production: process.env.APNS_PRODUCTION === '1',
    call_id: testCallId,
    hint: voipCount === 0
      ? 'No voip_token registered → killed-app CallKit will NOT ring; only a backgrounded app gets the regular call push.'
      : (apnsConfigured
          ? 'VoIP push dispatched — a fully-closed app should ring CallKit within a few seconds.'
          : 'voip_token present but APNs not configured on the server → VoIP push cannot be sent.'),
  });
}

module.exports = {
  listOwnDevices, listConversationDevices, revokeDevice, updateDevice,
  registerPushToken, requestHistory, listHistoryRequests, clearHistoryRequest,
  voipSelfTest,
};
