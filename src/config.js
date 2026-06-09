'use strict';

const os = require('node:os');

require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required dotenv var: ${name}`);
  return v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer in ${name}: ${v}`);
  return n;
}

function list(name, fallback = []) {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const isProd = process.env.NODE_ENV === 'production';

module.exports = {
  isProd,
  port: int('PORT', 3001),
  corsOrigins: list('CORS_ORIGINS'),

  // ── Multi-instance / HA ────────────────────────────────────────────
  // When REDIS_URL is set, the WS dispatch fans out across every process
  // through Redis pub/sub so a device connected to instance B still
  // receives signaling sent from instance A. Unset => single-instance,
  // behaves exactly as before (local-only registry).
  redisUrl: process.env.REDIS_URL || null,
  // Stable id for this process, used to suppress self-echo on the bus and
  // to tag presence. docker-compose sets INSTANCE_ID=blue|green.
  instanceId: process.env.INSTANCE_ID || os.hostname(),
  // Graceful shutdown: how long to keep serving (health=503 so the load
  // balancer deregisters us) before we close live WS sockets, and the hard
  // ceiling after which we force-exit.
  drainDelayMs: int('DRAIN_DELAY_MS', 5000),
  shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 15000),
  // Single fixed password (HTTP Basic) for the /status dashboard. When unset,
  // /status is disabled (503) rather than open.
  statusPassword: process.env.STATUS_PASSWORD || null,
  // Read-only git dir mounted into the container so /status can show the
  // deploy/commit history.
  gitDir: process.env.GIT_DIR || '/repo/.git',
  build: {
    commit: process.env.GIT_COMMIT || 'unknown',
    committedAt: process.env.GIT_COMMITTED_AT || null,
  },

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: process.env.SUPABASE_ANON_KEY || null,
  },

  jwt: {
    secret: required('JWT_SECRET'),
    accessTtl: int('JWT_ACCESS_TTL', 900),
    // 180 days default. Sliding window — every successful /auth/refresh
    // extends by another 180 days — so an active user stays signed in
    // indefinitely. Raise further via JWT_REFRESH_TTL if needed.
    refreshTtl: int('JWT_REFRESH_TTL', 60 * 60 * 24 * 180),
  },

  sms: {
    provider: process.env.SMS_PROVIDER || null,
    apiKey: process.env.SMS_API_KEY || null,
    from: process.env.SMS_FROM || null,
    // Dev mode: when no provider is set, log OTPs to stderr instead of sending.
    devMode: !process.env.SMS_PROVIDER,
  },

  media: {
    bucket: process.env.MEDIA_BUCKET || 'koro-media',
    maxSizeBytes: int('MEDIA_MAX_BYTES', 25 * 1024 * 1024),
  },

  push: {
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || null,
  },

  // WebRTC NAT traversal. A TURN relay is REQUIRED for peers behind
  // symmetric / carrier-grade NAT (most mobile data networks) — STUN alone
  // can't traverse those and the call silently fails.
  //
  // Preferred: Cloudflare Realtime TURN. Set TURN_KEY_ID + TURN_TOKEN and
  // the /calls/ice-servers endpoint mints short-lived credentials per
  // request (the secret token never leaves the server).
  //
  // Alternative: a provider with static long-term credentials (Metered,
  // Twilio, self-hosted coturn) via TURN_URLS + TURN_USERNAME/CREDENTIAL.
  ice: {
    stunUrls: list('STUN_URLS', ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']),
    turnUrls: list('TURN_URLS'),
    turnUsername: process.env.TURN_USERNAME || null,
    turnCredential: process.env.TURN_CREDENTIAL || null,
    // Cloudflare Realtime TURN (ephemeral credentials).
    cfTurnKeyId: process.env.TURN_KEY_ID || null,
    cfTurnToken: process.env.TURN_TOKEN || null,
    // TTL (seconds) for minted credentials — longer than any single call.
    turnTtl: int('TURN_TTL', 86400),
  },
};
