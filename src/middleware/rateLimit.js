'use strict';

/**
 * Fixed-window in-memory rate limiter. Good enough for single-process dev;
 * swap for Redis when horizontally scaling. Buckets are garbage-collected
 * every minute.
 */

const buckets = new Map(); // key -> { count, resetAt }

function hit({ key, max, windowMs }) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1, resetInMs: windowMs };
  }
  if (b.count >= max) {
    return { ok: false, remaining: 0, resetInMs: b.resetAt - now };
  }
  b.count += 1;
  return { ok: true, remaining: max - b.count, resetInMs: b.resetAt - now };
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Top-N recently rate-limited keys, for the status dashboard. Capped + decayed
// so it never grows unbounded.
const limitedKeys = new Map(); // key → { count, lastAt }
function noteLimited(key) {
  const e = limitedKeys.get(key);
  if (e) { e.count += 1; e.lastAt = Date.now(); }
  else {
    limitedKeys.set(key, { count: 1, lastAt: Date.now() });
    if (limitedKeys.size > 500) {
      const oldest = [...limitedKeys.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
      if (oldest) limitedKeys.delete(oldest[0]);
    }
  }
}

/** Snapshot for the status dashboard: active buckets + top limited keys (15m). */
function rateLimitStats() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const rows = [...limitedKeys.entries()]
    .filter(([, v]) => v.lastAt >= cutoff)
    .map(([key, v]) => ({ key, count: v.count, lastAt: v.lastAt }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  let total = 0;
  for (const v of limitedKeys.values()) if (v.lastAt >= cutoff) total += v.count;
  return { activeBuckets: buckets.size, total, top: rows };
}

function check(limits) {
  for (const l of limits) {
    const r = hit(l);
    if (!r.ok) {
      noteLimited(l.key);
      return {
        ok: false,
        status: 429,
        error: 'Too many requests',
        retryAfterSeconds: Math.ceil(r.resetInMs / 1000),
        headers: {
          'Retry-After': String(Math.ceil(r.resetInMs / 1000)),
          'X-RateLimit-Limit': String(l.max),
          'X-RateLimit-Remaining': '0',
        },
      };
    }
  }
  return { ok: true };
}

function send429(res, info) {
  res.writeHead(info.status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...info.headers,
  });
  res.end(JSON.stringify({ error: info.error, retry_after: info.retryAfterSeconds }));
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets.entries()) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}, 60_000).unref();

module.exports = { hit, check, send429, clientIp, rateLimitStats };
