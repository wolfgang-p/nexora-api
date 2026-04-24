'use strict';

const { prometheusText } = require('../util/metrics');

/**
 * GET /metrics — Prometheus text-format scrape target. Protected by a
 * shared bearer token in METRICS_TOKEN (no JWT — scrape is machine-to-
 * machine). If METRICS_TOKEN is unset, we only allow loopback access.
 */
function handler(req, res) {
  const token = process.env.METRICS_TOKEN;
  const header = req.headers['authorization'] || '';
  const presented = header.replace(/^Bearer\s+/i, '');
  const ip = req.socket?.remoteAddress || '';

  if (token) {
    if (presented !== token) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('unauthorized\n');
      return;
    }
  } else {
    // Loopback only when no token configured.
    if (!ip.startsWith('127.') && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('metrics endpoint requires METRICS_TOKEN in production\n');
      return;
    }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(prometheusText());
}

module.exports = { handler };
