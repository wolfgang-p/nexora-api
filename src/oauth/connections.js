'use strict';

const { supabase } = require('../db/supabase');
const { ok, forbidden } = require('../util/response');
const { audit } = require('../util/audit');

/**
 * GET /oauth/connections   (authed user)
 *
 * "Apps connected to your Koro account" — one entry per app the user has an
 * active OAuth token for, with the granted scopes. Backs a privacy/security
 * settings screen.
 */
async function list(req, res) {
  const { data: tokens } = await supabase.from('oauth_tokens')
    .select('id, client_id, device_id, scopes, created_at, last_used_at')
    .eq('user_id', req.auth.userId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });

  // Collapse to one entry per client (a client may have several rotated rows).
  const byClient = new Map();
  for (const t of tokens || []) {
    const existing = byClient.get(t.client_id);
    if (!existing || new Date(t.created_at) > new Date(existing.connected_at)) {
      byClient.set(t.client_id, {
        client_id: t.client_id,
        device_id: t.device_id,
        scopes: t.scopes,
        connected_at: t.created_at,
        last_used_at: t.last_used_at,
      });
    }
  }

  const clientIds = [...byClient.keys()];
  let apps = {};
  if (clientIds.length) {
    const { data: clients } = await supabase.from('oauth_clients')
      .select('client_id, name, logo_url, homepage_url').in('client_id', clientIds);
    apps = Object.fromEntries((clients || []).map((c) => [c.client_id, c]));
  }

  const connections = [...byClient.values()].map((c) => ({
    ...c,
    app: apps[c.client_id] || { client_id: c.client_id, name: c.client_id },
  }));
  ok(res, { connections });
}

/**
 * DELETE /oauth/connections/:clientId   (authed user)
 *
 * Disconnect an app: revoke all its tokens for this user AND revoke the
 * per-grant device(s), so the app can no longer act for them and gets no
 * further sealed message copies.
 */
async function revoke(req, res, { params }) {
  const clientId = params.clientId;
  const now = new Date().toISOString();

  const { data: tokens } = await supabase.from('oauth_tokens')
    .select('id, device_id').eq('user_id', req.auth.userId).eq('client_id', clientId).is('revoked_at', null);

  await supabase.from('oauth_tokens').update({ revoked_at: now })
    .eq('user_id', req.auth.userId).eq('client_id', clientId).is('revoked_at', null);

  const deviceIds = [...new Set((tokens || []).map((t) => t.device_id).filter(Boolean))];
  if (deviceIds.length) {
    await supabase.from('devices')
      .update({ revoked_at: now, revoked_reason: 'oauth_disconnect' })
      .in('id', deviceIds);
  }

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'oauth.connection.revoke', targetType: 'oauth_client', targetId: clientId,
    metadata: { revoked_devices: deviceIds.length }, req,
  });
  ok(res, { ok: true });
}

module.exports = { list, revoke };
