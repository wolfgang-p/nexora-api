'use strict';

const https = require('node:https');
const fs = require('node:fs');
const config = require('./config');
const { handleRequest } = require('./router');
const { attachWsServer } = require('./ws/server');
const { drainLocalSockets, stopBus } = require('./ws/dispatch');
const lifecycle = require('./util/lifecycle');
const webhookWorker = require('./webhooks/worker');
const scheduler = require('./scheduler');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// Use HTTPS if certs exist, fallback to HTTP
let server;
try {
  const certDir = process.env.CERT_DIR || '/etc/letsencrypt/live/api.koro.chat';
  const cert = fs.readFileSync(`${certDir}/fullchain.pem`, 'utf8');
  const key = fs.readFileSync(`${certDir}/privkey.pem`, 'utf8');
  server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[fatal]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      } else {
        res.end();
      }
    });
  });
  console.log('[koro-api] Using HTTPS');
} catch (err) {
  console.warn('[koro-api] HTTPS certs not found, falling back to HTTP:', err.message);
  const http = require('node:http');
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[fatal]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      } else {
        res.end();
      }
    });
  });
}

attachWsServer(server);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[koro-api] listening on 0.0.0.0:${config.port} (env=${config.isProd ? 'prod' : 'dev'})`);
  if (config.sms.devMode) console.warn('[koro-api] SMS provider not configured — OTPs will be logged to stderr');
  if (!config.corsOrigins.length) console.warn('[koro-api] CORS_ORIGINS empty — all origins allowed');
  webhookWorker.start();
  console.log('[koro-api] webhook retry worker started');
  scheduler.start();
});

// Graceful, zero-downtime-friendly shutdown:
//  1. Flip /health to 503 so Traefik stops routing NEW traffic here.
//  2. Wait drainDelayMs for the load balancer to deregister us.
//  3. Close live WS sockets so clients reconnect to the healthy instance
//     (active calls keep flowing — media is P2P/TURN, not via this server).
//  4. Tear down the Redis bus + HTTP server, then exit.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[koro-api] ${sig}; draining (health -> 503, instance=${config.instanceId})`);
  lifecycle.setDraining(true);

  const hard = setTimeout(() => {
    console.error('[koro-api] shutdown timeout — forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  hard.unref();

  webhookWorker.stop();
  scheduler.stop();

  await sleep(config.drainDelayMs);

  const closed = drainLocalSockets();
  console.log(`[koro-api] drained ${closed} ws socket(s)`);

  await stopBus();

  server.close(() => { clearTimeout(hard); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
