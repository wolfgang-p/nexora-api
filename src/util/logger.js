'use strict';

/**
 * Minimal structured logger. Emits one JSON object per line to stdout
 * (stderr for error/fatal), with PII scrubbing baked in so nobody leaks
 * a phone number or token into Sentry/Datadog indexing.
 *
 * Why not pino? We don't want the extra dep or the worker-thread machinery
 * when we only need ~50 log lines/sec. If we outgrow this, swap the
 * emit() body for a pino child — callers don't change.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const CURRENT = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

// Keys that should never land in logs even if a handler naïvely spreads an
// auth result or a user row. Values are replaced with "[redacted]".
const REDACT_KEYS = new Set([
  'phone', 'phone_e164', 'phone_hash',
  'password', 'code', 'code_hash', 'secret', 'refresh_token', 'access_token',
  'token', 'authorization', 'cookie',
  'identity_public_key', 'private_key', 'secret_key',
  'ciphertext', 'plaintext',
]);

function scrub(val, depth = 0) {
  if (depth > 5) return '[depth-limit]';
  if (val == null) return val;
  if (Array.isArray(val)) return val.map((v) => scrub(v, depth + 1));
  if (typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) {
      if (REDACT_KEYS.has(k.toLowerCase())) { out[k] = '[redacted]'; continue; }
      out[k] = scrub(val[k], depth + 1);
    }
    return out;
  }
  return val;
}

function emit(level, ...args) {
  if (LEVELS[level] < CURRENT) return;
  const msg = args.map((a) =>
    typeof a === 'string' ? a
      : a instanceof Error ? `${a.message}`
      : JSON.stringify(scrub(a))
  ).join(' ');

  const payload = { ts: new Date().toISOString(), level, msg };

  // Attach stack from first Error arg for error-level+ logs.
  if (LEVELS[level] >= LEVELS.error) {
    const err = args.find((a) => a instanceof Error);
    if (err) payload.stack = err.stack;
  }

  const line = JSON.stringify(payload);
  if (LEVELS[level] >= LEVELS.error) process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

const logger = {
  trace: (...a) => emit('trace', ...a),
  debug: (...a) => emit('debug', ...a),
  info:  (...a) => emit('info', ...a),
  warn:  (...a) => emit('warn', ...a),
  error: (...a) => emit('error', ...a),
  fatal: (...a) => emit('fatal', ...a),
  /** Create a namespaced child. `logger.child('messages.send').info(...)`. */
  child(scope) {
    return {
      trace: (...a) => emit('trace', `[${scope}]`, ...a),
      debug: (...a) => emit('debug', `[${scope}]`, ...a),
      info:  (...a) => emit('info',  `[${scope}]`, ...a),
      warn:  (...a) => emit('warn',  `[${scope}]`, ...a),
      error: (...a) => emit('error', `[${scope}]`, ...a),
      fatal: (...a) => emit('fatal', `[${scope}]`, ...a),
    };
  },
  scrub, // exported so Sentry's `beforeSend` can reuse it
};

module.exports = logger;
