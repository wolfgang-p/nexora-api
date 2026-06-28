'use strict';

/**
 * Action endpoints for the status dashboard — POST /status/action/:name.
 * Gated by the SAME Basic-auth password as the dashboard (checked in the
 * route handler before dispatch). Each action is intentionally small,
 * idempotent where possible, and records an event so the change is visible in
 * the dashboard's own event log.
 */

const { supabase } = require('../db/supabase');
const { disconnectDevice } = require('../ws/dispatch');

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const ACTIONS = {
  // Re-queue failed webhook deliveries (reset attempt so the worker retries).
  async 'webhooks.retry'(body) {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabase.from('webhook_deliveries')
      .update({ attempt: 0 })
      .is('delivered_at', null)
      .gte('attempt', 6)
      .gte('created_at', dayAgo)
      .select('id');
    if (error) throw new Error(error.message);
    return { requeued: (data || []).length };
  },

  // Revoke a single device (emergency). Disconnects its live socket too.
  async 'device.revoke'(body) {
    const id = String(body.deviceId || '').trim();
    if (!id) throw new Error('deviceId required');
    const { error } = await supabase.from('devices')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: 'status-dashboard' })
      .eq('id', id).is('revoked_at', null);
    if (error) throw new Error(error.message);
    try { disconnectDevice(id, 'revoked'); } catch { /* not connected here */ }
    return { revoked: id };
  },

  // Toggle a feature flag on/off (or set percent rollout).
  async 'flag.set'(body) {
    const key = String(body.key || '').trim();
    if (!key) throw new Error('key required');
    const rollout = ['off', 'on', 'percent', 'workspace'].includes(body.rollout) ? body.rollout : 'off';
    const row = {
      key,
      rollout,
      percent: body.percent ?? null,
      description: body.description ?? null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('feature_flags')
      .upsert(row, { onConflict: 'key' }).select('*').single();
    if (error) throw new Error(error.message);
    return { flag: data };
  },
};

/**
 * Handle POST /status/action/:name. Auth is already verified by the caller.
 * `name` is the action key; the JSON body carries action-specific params.
 */
async function statusAction(req, res, name) {
  const fn = ACTIONS[name];
  if (!fn) return json(res, 404, { error: `unknown action: ${name}` });
  let body;
  try { body = await readBody(req); } catch { body = {}; }
  try {
    const result = await fn(body);
    return json(res, 200, { ok: true, action: name, ...result });
  } catch (e) {
    return json(res, 400, { ok: false, error: e.message });
  }
}

module.exports = { statusAction, ACTIONS };
