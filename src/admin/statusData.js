'use strict';

/**
 * Status-dashboard data collectors. Kept separate from status.js (which owns
 * the per-instance Redis snapshot + HTML) so the heavier cross-cutting probes
 * live in one place. Everything here is READ-ONLY and best-effort: any failing
 * probe returns an { ok:false, error } shape rather than throwing, so one slow
 * subsystem never blanks the whole dashboard.
 */

const config = require('../config');
const { supabase } = require('../db/supabase');
const { getBusClient } = require('../ws/dispatch');
const { metricsSnapshot, routeSnapshot } = require('../util/metrics');
const { rateLimitStats } = require('../middleware/rateLimit');

let schedulerStatsFn = () => ({ jobs: {} });
try { schedulerStatsFn = require('../scheduler').schedulerStats || schedulerStatsFn; } catch { /* optional */ }

const since = (ms) => new Date(Date.now() - ms).toISOString();

async function count(table, build) {
  try {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    if (build) q = build(q);
    const { count: c } = await q;
    return c ?? 0;
  } catch { return null; }
}

// ── Live calls + meetings + connection success rate ────────────────────
async function collectRealtime() {
  try {
    const dayAgo = since(24 * 3600 * 1000);
    const [
      activeCalls, activeMeetings, liveParticipants,
      callsToday, callsOkToday, callsFailedToday, callsMissedToday,
      meetingsToday,
    ] = await Promise.all([
      count('calls', (q) => q.is('ended_at', null).not('started_at', 'is', null)),
      count('meetings', (q) => q.not('started_at', 'is', null).is('ended_at', null)),
      count('meeting_participants', (q) => q.is('left_at', null)),
      count('calls', (q) => q.gte('started_at', dayAgo)),
      count('calls', (q) => q.gte('started_at', dayAgo).eq('end_reason', 'normal')),
      count('calls', (q) => q.gte('started_at', dayAgo).in('end_reason', ['failed', 'unreachable'])),
      count('calls', (q) => q.gte('started_at', dayAgo).in('end_reason', ['missed', 'rejected', 'canceled'])),
      count('meetings', (q) => q.gte('created_at', dayAgo)),
    ]);

    // Average duration of today's completed calls.
    let avgDurationSec = null;
    try {
      const { data } = await supabase.from('calls')
        .select('duration_seconds')
        .gte('started_at', dayAgo)
        .not('duration_seconds', 'is', null)
        .limit(2000);
      if (data && data.length) {
        avgDurationSec = Math.round(data.reduce((a, r) => a + (r.duration_seconds || 0), 0) / data.length);
      }
    } catch { /* ignore */ }

    const connectable = (callsOkToday || 0) + (callsFailedToday || 0);
    const successRate = connectable > 0 ? (callsOkToday || 0) / connectable : null;

    return {
      ok: true,
      activeCalls, activeMeetings, liveParticipants,
      callsToday, callsOkToday, callsFailedToday, callsMissedToday, meetingsToday,
      avgDurationSec, successRate,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Presence: online devices/users across instances ───────────────────
// Device-level online status lives in the WS layer; resolve to users via DB.
async function collectPresence(instances) {
  try {
    const totalSockets = Object.values(instances).reduce((a, i) => a + (i.ws?.sockets || 0), 0);
    const localDevices = Object.values(instances).reduce((a, i) => a + (i.ws?.devices || 0), 0);
    const remoteDevices = Object.values(instances).reduce((a, i) => a + (i.ws?.remoteDevices || 0), 0);
    // localDevices already counts this-instance devices on each snapshot; the
    // peer mirror (remoteDevices) double-counts the same set seen from peers,
    // so the true online-device count is the max local view. Use the largest
    // single-instance "devices + remoteDevices" as a robust upper bound.
    const onlineDevices = Math.max(
      localDevices,
      ...Object.values(instances).map((i) => (i.ws?.devices || 0) + (i.ws?.remoteDevices || 0)),
      0,
    );
    return { ok: true, totalSockets, onlineDevices, instances: Object.keys(instances).length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Push delivery health (from metrics counters) ───────────────────────
function collectPush() {
  const c = metricsSnapshot().counters || {};
  const sent = c['push_sent_total'] || 0;
  const failed = c['push_failed_total'] || 0;
  const dead = c['push_dead_token_total'] || 0;
  const errored = c['push_error_total'] || 0;
  const attempts = sent + failed + errored;
  return {
    ok: true,
    sent, failed, dead, errored,
    successRate: attempts > 0 ? sent / attempts : null,
  };
}

// ── Webhook worker health (from webhook_deliveries) ────────────────────
async function collectWebhooks() {
  try {
    const dayAgo = since(24 * 3600 * 1000);
    const [pending, deliveredToday, failedToday, hooks, deadletter] = await Promise.all([
      count('webhook_deliveries', (q) => q.is('delivered_at', null).lt('attempt', 6)),
      count('webhook_deliveries', (q) => q.gte('created_at', dayAgo).not('delivered_at', 'is', null)),
      count('webhook_deliveries', (q) => q.gte('created_at', dayAgo).is('delivered_at', null).gte('response_status', 400)),
      count('webhooks', (q) => q),
      count('webhook_deliveries', (q) => q.is('delivered_at', null).gte('attempt', 6)),
    ]);
    let recentFailures = [];
    try {
      const { data } = await supabase.from('webhook_deliveries')
        .select('event, response_status, attempt, created_at')
        .is('delivered_at', null)
        .gte('attempt', 1)
        .order('created_at', { ascending: false })
        .limit(8);
      recentFailures = data || [];
    } catch { /* ignore */ }
    const total = (deliveredToday || 0) + (failedToday || 0);
    return {
      ok: true,
      pending, deliveredToday, failedToday, deadletter, hooks,
      successRate: total > 0 ? (deliveredToday || 0) / total : null,
      recentFailures,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Audit / security feed ──────────────────────────────────────────────
async function collectAudit() {
  try {
    const { data } = await supabase.from('audit_events')
      .select('action, target_type, actor_user_id, ip_address, created_at, metadata')
      .order('created_at', { ascending: false })
      .limit(40);
    const dayAgo = since(24 * 3600 * 1000);
    const [failedLogins, newDevices, revokes, deletions] = await Promise.all([
      count('audit_events', (q) => q.gte('created_at', dayAgo).in('action', ['auth.login_failed', 'auth.totp_failed'])),
      count('audit_events', (q) => q.gte('created_at', dayAgo).eq('action', 'device.enrolled')),
      count('audit_events', (q) => q.gte('created_at', dayAgo).in('action', ['session.revoked', 'device.revoked'])),
      count('audit_events', (q) => q.gte('created_at', dayAgo).like('action', '%.delete%')),
    ]);
    return { ok: true, events: data || [], failedLogins, newDevices, revokes, deletions };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Business / product KPIs ────────────────────────────────────────────
async function collectKpis() {
  try {
    const dayAgo = since(24 * 3600 * 1000);
    const weekAgo = since(7 * 24 * 3600 * 1000);
    const [
      usersTotal, usersToday, usersWeek,
      messagesToday, meetingsTotal, workspacesTotal, botsTotal,
      activeUsersWeek,
    ] = await Promise.all([
      count('users', (q) => q),
      count('users', (q) => q.gte('created_at', dayAgo)),
      count('users', (q) => q.gte('created_at', weekAgo)),
      count('messages', (q) => q.gte('created_at', dayAgo)),
      count('meetings', (q) => q),
      count('workspaces', (q) => q.is('deleted_at', null)),
      count('devices', (q) => q.eq('kind', 'api_bot').is('revoked_at', null)),
      count('devices', (q) => q.gte('last_seen_at', weekAgo)),
    ]);
    return {
      ok: true,
      usersTotal, usersToday, usersWeek,
      messagesToday, meetingsTotal, workspacesTotal, botsTotal, activeUsersWeek,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Client distribution (by device kind) ───────────────────────────────
async function collectClients() {
  try {
    const weekAgo = since(7 * 24 * 3600 * 1000);
    const kinds = ['mobile', 'web', 'desktop', 'crm_seat', 'api_bot'];
    const entries = await Promise.all(kinds.map(async (k) => [
      k,
      await count('devices', (q) => q.eq('kind', k).is('revoked_at', null).gte('last_seen_at', weekAgo)),
    ]));
    return { ok: true, byKind: Object.fromEntries(entries) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── TURN / ICE provider config + reachability hint ─────────────────────
function collectTurn() {
  const t = config.ice || {};
  const provider = t.cfTurnKeyId ? 'cloudflare' : (t.turnUrls && t.turnUrls.length ? 'static' : 'none');
  return {
    ok: true,
    provider,
    configured: provider !== 'none',
    cloudflare: !!t.cfTurnKeyId,
    staticUrls: (t.turnUrls || []).length,
    stunUrls: (t.stunUrls || []).length,
  };
}

// ── Deploy / version drift across instances ────────────────────────────
function collectDeploy(instances) {
  const versions = [...new Set(Object.values(instances).map((i) => i.version).filter(Boolean))];
  return {
    ok: true,
    running: config.build.commit,
    committedAt: config.build.committedAt,
    drift: versions.length > 1,
    versions,
  };
}

// ── DB depth (pool/size best-effort) ───────────────────────────────────
async function collectDbDepth() {
  // Supabase REST has no pool/size introspection; surface what we can cheaply.
  // Table-size + pool stats would need an RPC; left as a hook for later.
  return { ok: true, note: 'pool/size introspection requires a DB RPC (TODO)' };
}

// ── APM + rate-limit + scheduler (in-process, instant) ─────────────────
function collectApm() {
  const routes = routeSnapshot()
    .filter((r) => r.count > 0)
    .sort((a, b) => b.p95Ms - a.p95Ms);
  const byErrors = [...routes].sort((a, b) => b.errors - a.errors).filter((r) => r.errors > 0).slice(0, 8);
  const status = metricsSnapshot().counters || {};
  const buckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const [k, v] of Object.entries(status)) {
    const m = k.match(/http_responses_total\{status="(\d)\d\d"\}/);
    if (m) buckets[`${m[1]}xx`] = (buckets[`${m[1]}xx`] || 0) + v;
  }
  return { slowest: routes.slice(0, 12), topErrors: byErrors, statusBuckets: buckets };
}

// ── Health score (composite traffic light) ─────────────────────────────
function computeHealth({ instances, redis, db, realtime, push, webhooks, scheduler, deploy }) {
  const alerts = [];
  const now = Date.now();
  const fresh = Object.values(instances).filter((i) => now - i.ts < 20000);
  if (fresh.length === 0) alerts.push({ level: 'crit', text: 'Keine API-Instanz meldet sich' });
  if (db && !db.ok) alerts.push({ level: 'crit', text: 'Datenbank nicht erreichbar' });
  else if (db && db.latencyMs > 250) alerts.push({ level: 'warn', text: `DB-Latenz hoch (${db.latencyMs} ms)` });
  if (redis && !redis.ok) alerts.push({ level: 'warn', text: 'Redis nicht erreichbar' });
  for (const i of fresh) {
    const heapMax = i.mem?.heapLimit || i.mem?.heapTotal;
    if (heapMax && i.mem.heapUsed / heapMax > 0.9) alerts.push({ level: 'warn', text: `Heap > 90 % auf ${i.instance}` });
    if (i.eventLoopLagMs?.p99 > 200) alerts.push({ level: 'warn', text: `Event-Loop-Lag hoch auf ${i.instance}` });
    const disk = i.disk?.uploads || i.disk?.root;
    if (disk && disk.usedPct > 90) alerts.push({ level: 'warn', text: `Disk > 90 % auf ${i.instance}` });
  }
  if (push && push.successRate != null && push.successRate < 0.8 && (push.sent + push.failed) > 20) {
    alerts.push({ level: 'warn', text: `Push-Erfolgsquote ${(push.successRate * 100).toFixed(0)} %` });
  }
  if (webhooks && webhooks.deadletter > 0) alerts.push({ level: 'warn', text: `${webhooks.deadletter} Webhook(s) in Dead-Letter` });
  if (webhooks && webhooks.pending > 100) alerts.push({ level: 'warn', text: `Webhook-Queue staut (${webhooks.pending})` });
  if (realtime && realtime.successRate != null && realtime.successRate < 0.7 && realtime.callsToday > 10) {
    alerts.push({ level: 'warn', text: `Anruf-Erfolgsquote ${(realtime.successRate * 100).toFixed(0)} %` });
  }
  if (deploy && deploy.drift) alerts.push({ level: 'warn', text: 'Version-Drift zwischen Instanzen' });
  if (scheduler && scheduler.lastTickAt && now - scheduler.lastTickAt > 90000) {
    alerts.push({ level: 'crit', text: 'Scheduler reagiert nicht (überfällig)' });
  }
  for (const [name, j] of Object.entries(scheduler?.jobs || {})) {
    if (j.lastError) alerts.push({ level: 'warn', text: `Job „${name}" Fehler` });
  }

  const level = alerts.some((a) => a.level === 'crit') ? 'crit'
    : alerts.some((a) => a.level === 'warn') ? 'warn' : 'ok';
  return { level, alerts };
}

module.exports = {
  collectRealtime, collectPresence, collectPush, collectWebhooks, collectAudit,
  collectKpis, collectClients, collectTurn, collectDeploy, collectDbDepth, collectApm,
  computeHealth, rateLimitStats, schedulerStats: schedulerStatsFn,
};
