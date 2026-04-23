'use strict';

const { supabase } = require('../db/supabase');
const { ok, forbidden, notFound } = require('../util/response');
const { audit } = require('../util/audit');
const { disconnectDevice } = require('../ws/dispatch');

/**
 * GET /devices   (self)
 */
async function listOwnDevices(req, res) {
  const { data: devices } = await supabase
    .from('devices')
    .select('id, kind, label, fingerprint, enrolled_at, last_seen_at, revoked_at, user_agent, location_hint')
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
 * PUT /devices/:id   (self)  { label?, location_hint? }
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
  if (Object.keys(patch).length === 0) return ok(res, { ok: true });

  await supabase.from('devices').update(patch).eq('id', params.id);
  ok(res, { ok: true });
}

/**
 * POST /devices/push-token   { token, platform? }
 * Registers / refreshes this device's Expo push token.
 */
async function registerPushToken(req, res) {
  const { readJson, badRequest } = require('../util/response');
  const body = await readJson(req).catch(() => null);
  if (!body?.token) return badRequest(res, 'token required');

  await supabase.from('push_tokens').upsert({
    device_id: req.auth.deviceId,
    platform: body.platform || req.headers['x-platform'] || 'unknown',
    token: body.token,
    last_used_at: new Date().toISOString(),
  }, { onConflict: 'device_id' });

  ok(res, { ok: true });
}

module.exports = {
  listOwnDevices, listConversationDevices, revokeDevice, updateDevice,
  registerPushToken,
};
