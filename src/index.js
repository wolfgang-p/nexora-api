'use strict';

const http = require('node:http');
const config = require('./config');
const { handleRequest } = require('./router');
const { attachWsServer } = require('./ws/server');
const webhookWorker = require('./webhooks/worker');

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

const server = http.createServer((req, res) => {
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

attachWsServer(server);

server.listen(config.port, () => {
  console.log(`[koro-api] listening on :${config.port} (env=${config.isProd ? 'prod' : 'dev'})`);
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
