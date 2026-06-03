'use strict';

const { WebSocketServer } = require('ws');
const { verifyAccess } = require('../auth/jwt');
const { supabase } = require('../db/supabase');
const { register, unregister, sendTo, startBus } = require('./dispatch');
const { route } = require('./router');

const AUTH_TIMEOUT_MS = 5_000;

function attachWsServer(httpServer) {
  // Bring up the Redis fan-out bus (no-op when REDIS_URL is unset, i.e.
  // single-instance mode). Lets sockets on other instances receive signaling.
  startBus();

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.auth = null;

    const authTimer = setTimeout(() => {
      if (!ws.auth) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'auth_timeout' })); } catch {}
        ws.close(4000, 'auth_timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); }
      catch { return send(ws, { type: 'error', error: 'invalid_json' }); }

      if (data.type === 'auth') {
        try {
          const claims = verifyAccess(data.token || '');
          const { data: device } = await supabase
            .from('devices').select('id, user_id, revoked_at')
            .eq('id', claims.deviceId).maybeSingle();
          if (!device || device.revoked_at || device.user_id !== claims.userId) {
            send(ws, { type: 'error', error: 'invalid_device' });
            ws.close(4001, 'invalid_device');
            return;
          }
          ws.auth = claims;
          register(claims.deviceId, ws);
          clearTimeout(authTimer);
          send(ws, { type: 'auth.ok', device_id: claims.deviceId, user_id: claims.userId });
          // Update last_seen
          supabase.from('devices').update({ last_seen_at: new Date().toISOString() })
            .eq('id', claims.deviceId).then(() => {}, () => {});
        } catch {
          send(ws, { type: 'error', error: 'auth_failed' });
          ws.close(4001, 'auth_failed');
        }
        return;
      }

      // koro-meet guest authentication. Anonymous browsers reach the WS
      // through this path — we don't mint a Koro session for them, just
      // tag the socket with a guest "meet:<uuid>" handle that lives only
      // for the WS lifetime. Signaling routes recognise the prefix and
      // restrict guest traffic to meeting.* events.
      if (data.type === 'meet.auth') {
        const meetingId = String(data.meeting_id || '').trim();
        const guestDeviceId = String(data.device_id || '').trim();
        if (!meetingId || !guestDeviceId) {
          send(ws, { type: 'error', error: 'meet.auth requires meeting_id + device_id' });
          ws.close(4002, 'meet_auth_missing');
          return;
        }
        // Verify the meeting exists + isn't ended. Doesn't gate on
        // participation here — the join endpoint is the source of
        // truth for that. WS just relays.
        const { data: meeting } = await supabase.from('meetings')
          .select('id, ended_at').eq('room_id', meetingId).maybeSingle();
        if (!meeting || meeting.ended_at) {
          send(ws, { type: 'error', error: 'meeting_not_found' });
          ws.close(4002, 'meeting_not_found');
          return;
        }
        const handle = `meet:${guestDeviceId}`;
        ws.auth = { kind: 'meet-guest', deviceId: handle, meetingId, userId: null };
        register(handle, ws);
        clearTimeout(authTimer);
        send(ws, { type: 'meet.auth.ok', device_id: handle, meeting_id: meetingId });
        return;
      }

      if (!ws.auth) {
        return send(ws, { type: 'error', error: 'not_authenticated' });
      }

      try {
        await route(ws, data);
      } catch (err) {
        console.error('[ws]', err);
        send(ws, { type: 'error', error: 'handler_failed' });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (ws.auth) unregister(ws.auth.deviceId, ws);
    });
  });

  // Heartbeat
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function send(ws, payload) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

module.exports = { attachWsServer };
