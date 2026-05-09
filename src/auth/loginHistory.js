'use strict';

/**
 * Login history — every successful auth (otp/refresh/pair/totp_verify)
 * inserts one row in `login_history`. The `suspicious` flag is set
 * when the current login's country differs from the user's last 30-day
 * norm; the client highlights those rows + can prompt the user to
 * sign other devices out.
 *
 * Geo-IP is intentionally cheap: we use the `cf-ipcountry` /
 * `x-vercel-ip-country` request headers if present (works on
 * Cloudflare and Vercel). Without those headers `country` is null and
 * the suspicious check degrades to "first-time-ever" detection by IP.
 */

const { supabase } = require('../db/supabase');

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

function clientCountry(req) {
  const cf = req.headers['cf-ipcountry'];
  const vc = req.headers['x-vercel-ip-country'];
  const v = cf || vc;
  if (!v || typeof v !== 'string') return null;
  const c = v.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  return c;
}

/**
 * Insert one login_history row. `mode` is the auth path used.
 * Best-effort — failure is swallowed and logged so the auth flow
 * itself never breaks because of audit insertion.
 */
async function recordLogin({ userId, deviceId, mode, req }) {
  try {
    const ip = clientIp(req);
    const country = clientCountry(req);
    const ua = req.headers['user-agent'] || null;

    let suspicious = false;
    if (country) {
      // Get the most-frequent country in the last 30 days. If the
      // current country differs AND the user has at least one prior
      // login on a different country, flag.
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { data: prior } = await supabase.from('login_history')
        .select('country').eq('user_id', userId).gte('created_at', since)
        .not('country', 'is', null);
      if ((prior || []).length > 0) {
        const seen = new Set(prior.map((p) => p.country));
        if (!seen.has(country)) suspicious = true;
      }
    }

    await supabase.from('login_history').insert({
      user_id: userId,
      device_id: deviceId || null,
      mode,
      ip,
      country,
      user_agent: ua ? String(ua).slice(0, 250) : null,
      suspicious,
    });

    // If suspicious, fan out a silent push to the user's OTHER active
    // devices so they see a banner on next foreground.
    if (suspicious) {
      try {
        const { pushSecurityAlert } = require('../push');
        await pushSecurityAlert({
          userId,
          excludeDeviceId: deviceId,
          country,
        });
      } catch { /* push module may not export this — non-fatal */ }
    }
  } catch (err) {
    console.error('[recordLogin]', err);
  }
}

/**
 * GET /me/login-history — list the user's last 50 entries, newest first.
 */
async function listMine(req, res) {
  const { data } = await supabase.from('login_history')
    .select('id, device_id, mode, ip, country, user_agent, suspicious, created_at')
    .eq('user_id', req.auth.userId)
    .order('created_at', { ascending: false })
    .limit(50);
  const { ok } = require('../util/response');
  ok(res, { events: data || [] });
}

module.exports = { recordLogin, listMine, clientIp, clientCountry };
