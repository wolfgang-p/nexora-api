'use strict';

/**
 * In-process registry of live WebSocket connections keyed by device_id.
 * A single device may have multiple sockets (reconnect races); we keep a Set.
 *
 * For multi-process deployments, swap this registry for Redis pub/sub where
 * each process listens for `device:<id>` channels and a sender publishes
 * rather than calling `broadcastToDevices` directly.
 */
const deviceSockets = new Map(); // Map<device_id, Set<WebSocket>>

function register(deviceId, ws) {
  if (!deviceSockets.has(deviceId)) deviceSockets.set(deviceId, new Set());
  deviceSockets.get(deviceId).add(ws);
}

function unregister(deviceId, ws) {
  const s = deviceSockets.get(deviceId);
  if (!s) return;
  s.delete(ws);
  if (s.size === 0) deviceSockets.delete(deviceId);
}

function sendTo(deviceId, payload) {
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

/**
 * Send to a list of devices. `payloadFn(deviceId)` lets callers vary the
 * payload per-device (e.g. each recipient's own ciphertext).
 */
function broadcastToDevices(deviceIds, payloadFn) {
  for (const id of new Set(deviceIds)) {
    const payload = payloadFn(id);
    if (payload) sendTo(id, payload);
  }
}

function disconnectDevice(deviceId, reason = 'revoked') {
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

function deviceOnline(deviceId) {
  return deviceSockets.has(deviceId);
}

module.exports = { register, unregister, sendTo, broadcastToDevices, disconnectDevice, deviceOnline };
