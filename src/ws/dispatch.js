'use strict';

const config = require('../config');

/**
 * WebSocket dispatch registry.
 *
 * Single-instance (REDIS_URL unset): a plain in-process Map of live sockets,
 * keyed by device_id — identical behaviour to the original implementation.
 *
 * Multi-instance (REDIS_URL set): the same local Map PLUS a Redis pub/sub bus
 * so a payload addressed to a device connected to *another* process still
 * reaches it. Every `sendTo` delivers locally and, when the target isn't
 * (only) local, publishes onto the bus; each process delivers bus messages to
 * its own local sockets. A lightweight presence mirror keeps `deviceOnline`
 * accurate across instances (used for call ringing + push fallback).
 *
 * The public function signatures are unchanged, so the 15+ call sites across
 * the codebase keep working without modification.
 */

const INSTANCE_ID = config.instanceId;

// ── Local state ────────────────────────────────────────────────────────
const deviceSockets = new Map(); // Map<device_id, Set<WebSocket>>

// Mirror of which devices are online on OTHER instances.
// Map<instance_id, { devices: Set<device_id>, lastSeen: number }>
const remoteByInstance = new Map();
const REMOTE_TTL_MS = 70_000; // drop an instance's mirror if silent this long

// ── Redis bus (optional) ───────────────────────────────────────────────
const CH_FANOUT = 'koro:ws:fanout';     // delivery + disconnect control
const CH_PRESENCE = 'koro:ws:presence'; // online/offline/snapshot/sync
let pub = null;
let sub = null;
let timers = [];

function busEnabled() {
  return pub != null;
}

/** Wire up Redis. No-op (single-instance mode) when REDIS_URL is unset. */
function startBus() {
  if (!config.redisUrl || pub) return;
  const Redis = require('ioredis');
  const opts = { lazyConnect: false, maxRetriesPerRequest: null, enableOfflineQueue: true };
  pub = new Redis(config.redisUrl, opts);
  sub = pub.duplicate();

  pub.on('error', (e) => console.error('[ws-bus] pub error:', e.message));
  sub.on('error', (e) => console.error('[ws-bus] sub error:', e.message));

  sub.subscribe(CH_FANOUT, CH_PRESENCE).then(() => {
    console.log(`[ws-bus] subscribed (instance=${INSTANCE_ID})`);
    // Announce ourselves and ask peers to reply with a snapshot so we learn
    // the current cross-instance presence within one round-trip.
    publishPresence({ k: 'snapshot', devices: localDeviceIds() });
    publishPresence({ k: 'sync' });
  });

  sub.on('message', (chan, raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.origin === INSTANCE_ID) return; // ignore our own echo
    if (chan === CH_FANOUT) onFanout(m);
    else if (chan === CH_PRESENCE) onPresence(m);
  });

  // Periodically re-announce a full snapshot (refreshes peers' TTLs) and
  // sweep instances that have gone silent (crashed / network partition).
  timers.push(setInterval(() => publishPresence({ k: 'snapshot', devices: localDeviceIds() }), 25_000));
  timers.push(setInterval(sweepStaleInstances, 30_000));
  timers.forEach((t) => t.unref && t.unref());
}

async function stopBus() {
  timers.forEach((t) => clearInterval(t));
  timers = [];
  const clients = [pub, sub].filter(Boolean);
  pub = null; sub = null;
  await Promise.allSettled(clients.map((c) => c.quit().catch(() => c.disconnect())));
}

function publishFanout(msg) {
  if (pub) pub.publish(CH_FANOUT, JSON.stringify({ ...msg, origin: INSTANCE_ID })).catch(() => {});
}
function publishPresence(msg) {
  if (pub) pub.publish(CH_PRESENCE, JSON.stringify({ ...msg, origin: INSTANCE_ID })).catch(() => {});
}

function onFanout(m) {
  if (m.k === 'send') localSend(m.deviceId, m.payload);
  else if (m.k === 'disconnect') localDisconnect(m.deviceId, m.reason);
}

function onPresence(m) {
  const now = Date.now();
  if (m.k === 'sync') {
    // A peer (re)joined and wants current state — reply with our snapshot.
    publishPresence({ k: 'snapshot', devices: localDeviceIds() });
    return;
  }
  let entry = remoteByInstance.get(m.origin);
  if (!entry) { entry = { devices: new Set(), lastSeen: now }; remoteByInstance.set(m.origin, entry); }
  entry.lastSeen = now;
  if (m.k === 'snapshot') entry.devices = new Set(m.devices || []);
  else if (m.k === 'online') entry.devices.add(m.deviceId);
  else if (m.k === 'offline') entry.devices.delete(m.deviceId);
}

function sweepStaleInstances() {
  const cutoff = Date.now() - REMOTE_TTL_MS;
  for (const [id, entry] of remoteByInstance) {
    if (entry.lastSeen < cutoff) remoteByInstance.delete(id);
  }
}

function localDeviceIds() {
  return [...deviceSockets.keys()];
}

function remoteHas(deviceId) {
  for (const entry of remoteByInstance.values()) {
    if (entry.devices.has(deviceId)) return true;
  }
  return false;
}

// ── Local socket delivery ──────────────────────────────────────────────
function localSend(deviceId, payload) {
  const s = deviceSockets.get(deviceId);
  if (!s) return false;
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let sent = false;
  for (const ws of s) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(msg); sent = true; } catch { /* ignore */ }
    }
  }
  return sent;
}

function localDisconnect(deviceId, reason = 'revoked') {
  const s = deviceSockets.get(deviceId);
  if (!s) return;
  for (const ws of s) {
    try {
      ws.send(JSON.stringify({ type: 'session.revoked', reason }));
      ws.close(4001, reason);
    } catch { /* ignore */ }
  }
  deviceSockets.delete(deviceId);
}

// ── Public API (unchanged signatures) ──────────────────────────────────
function register(deviceId, ws) {
  const fresh = !deviceSockets.has(deviceId);
  if (fresh) deviceSockets.set(deviceId, new Set());
  deviceSockets.get(deviceId).add(ws);
  if (fresh) publishPresence({ k: 'online', deviceId });
}

function unregister(deviceId, ws) {
  const s = deviceSockets.get(deviceId);
  if (!s) return;
  s.delete(ws);
  if (s.size === 0) {
    deviceSockets.delete(deviceId);
    publishPresence({ k: 'offline', deviceId });
  }
}

function sendTo(deviceId, payload) {
  const local = localSend(deviceId, payload);
  // Forward over the bus unless we know the device lives only here. When not
  // delivered locally we always forward (it may be on another instance, or
  // its presence hasn't propagated yet).
  if (busEnabled() && (!local || remoteHas(deviceId))) {
    publishFanout({ k: 'send', deviceId, payload });
  }
  return local;
}

/**
 * Send to a list of devices. `payloadFn(deviceId)` lets callers vary the
 * payload per-device (e.g. each recipient's own ciphertext). Each resolved
 * payload is delivered locally and, when relevant, published onto the bus.
 */
function broadcastToDevices(deviceIds, payloadFn) {
  for (const id of new Set(deviceIds)) {
    const payload = payloadFn(id);
    if (payload) sendTo(id, payload);
  }
}

function disconnectDevice(deviceId, reason = 'revoked') {
  localDisconnect(deviceId, reason);
  if (busEnabled()) publishFanout({ k: 'disconnect', deviceId, reason });
}

/** True if the device has a live socket on ANY instance. */
function deviceOnline(deviceId) {
  return deviceSockets.has(deviceId) || remoteHas(deviceId);
}

/** Live counts for the admin overview (this instance only). */
function wsStats() {
  let sockets = 0;
  for (const s of deviceSockets.values()) sockets += s.size;
  let remoteDevices = 0;
  for (const e of remoteByInstance.values()) remoteDevices += e.devices.size;
  return {
    instance: INSTANCE_ID,
    devices: deviceSockets.size,
    sockets,
    peerInstances: remoteByInstance.size,
    remoteDevices,
  };
}

/** Gracefully close every local socket so clients reconnect elsewhere. */
function drainLocalSockets(code = 1012, reason = 'restart') {
  let closed = 0;
  for (const set of deviceSockets.values()) {
    for (const ws of set) {
      try { ws.send(JSON.stringify({ type: 'server.draining' })); ws.close(code, reason); closed++; }
      catch { /* ignore */ }
    }
  }
  return closed;
}

module.exports = {
  register, unregister, sendTo, broadcastToDevices, disconnectDevice,
  deviceOnline, wsStats, startBus, stopBus, drainLocalSockets,
};
