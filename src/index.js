'use strict';

const https = require('node:https');
const fs = require('node:fs');
const config = require('./config');
const { handleRequest } = require('./router');
const { attachWsServer } = require('./ws/server');
const webhookWorker = require('./webhooks/worker');

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err);

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
});

function shutdown(sig) {
  console.log(`[koro-api] ${sig}; shutting down`);
  webhookWorker.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
