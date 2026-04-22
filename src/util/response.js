'use strict';

function send(res, status, body, extraHeaders = {}) {
  const payload = body == null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function ok(res, body = { ok: true }) {
  send(res, 200, body);
}

function created(res, body) {
  send(res, 201, body);
}

function noContent(res) {
  res.writeHead(204, { 'Content-Length': 0 });
  res.end();
}

function badRequest(res, msg = 'Bad request', extra) {
  send(res, 400, { error: msg, ...(extra || {}) });
}

function unauthorized(res, msg = 'Unauthorized') {
  send(res, 401, { error: msg });
}

function forbidden(res, msg = 'Forbidden') {
  send(res, 403, { error: msg });
}

function notFound(res, msg = 'Not found') {
  send(res, 404, { error: msg });
}

function conflict(res, msg = 'Conflict') {
  send(res, 409, { error: msg });
}

function serverError(res, msg = 'Internal error', err) {
  if (err) console.error('[500]', err);
  send(res, 500, { error: msg });
}

async function readJson(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

module.exports = {
  send, ok, created, noContent, badRequest, unauthorized, forbidden, notFound,
  conflict, serverError, readJson,
};
