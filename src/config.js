'use strict';

require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
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

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: process.env.SUPABASE_ANON_KEY || null,
  },

  jwt: {
    secret: required('JWT_SECRET'),
    accessTtl: int('JWT_ACCESS_TTL', 900),
    refreshTtl: int('JWT_REFRESH_TTL', 60 * 60 * 24 * 30),
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
};
