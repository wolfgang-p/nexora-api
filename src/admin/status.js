'use strict';

/**
 * Status dashboard at GET /status (HTML) + GET /status/data (JSON).
 *
 * Single fixed password via HTTP Basic (config.statusPassword). One "user" —
 * the username is ignored, only the password is checked (constant-time).
 *
 * Aggregates, across BOTH api instances:
 *   - per-instance health: uptime, version, memory, CPU, event-loop lag, ws
 *   - Redis: ping, memory, clients, version, uptime
 *   - Database: reachability + latency + estimated row counts
 *   - host load: loadavg, cpu%, memory, disk (uploads volume), uptime
 *   - event log: boot / shutdown / deploy events (restart history)
 *   - git/deploy history (from the mounted read-only .git)
 *
 * Each instance writes its own snapshot to Redis every 5s (TTL 15s); whichever
 * instance serves the request reads every instance's snapshot back.
 */

const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const v8 = require('node:v8');

const config = require('../config');
const { getBusClient, wsStats } = require('../ws/dispatch');
const { supabase } = require('../db/supabase');
const sd = require("./statusData");

const STARTED_AT = Date.now();

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

let lastProcCpu = process.cpuUsage();
let lastProcCpuAt = Date.now();
let lastSysCpu = sampleSysCpu();

// ── Sampling helpers ───────────────────────────────────────────────────
function sampleSysCpu() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

function hostCpuPercent() {
  const cur = sampleSysCpu();
  const dt = cur.total - lastSysCpu.total;
  const di = cur.idle - lastSysCpu.idle;
  lastSysCpu = cur;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - di / dt) * 100));
}

function diskFor(path) {
  try {
    const s = fs.statfsSync(path);
    const total = s.blocks * s.bsize;
    const free = s.bfree * s.bsize;
    const avail = s.bavail * s.bsize;
    return { total, free, avail, used: total - free, usedPct: total ? (1 - free / total) * 100 : 0 };
  } catch { return null; }
}

/** This instance's live snapshot. */
function collectLocal() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const now = Date.now();
  const dtMs = now - lastProcCpuAt;
  const procCpuPct = dtMs > 0
    ? Math.max(0, ((cpu.user + cpu.system) - (lastProcCpu.user + lastProcCpu.system)) / 1000 / dtMs * 100)
    : 0;
  lastProcCpu = cpu; lastProcCpuAt = now;

  return {
    instance: config.instanceId,
    pid: process.pid,
    version: config.build.commit,
    versionAt: config.build.committedAt,
    startedAt: STARTED_AT,
    uptimeSec: Math.floor((now - STARTED_AT) / 1000),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    ws: wsStats(),
    // heapTotal = aktuell von V8 reservierter Heap (wächst bei Bedarf);
    // heapLimit = das ECHTE Maximum (V8 heap_size_limit, ~max-old-space-size).
    // Für die Auslastung zählt heapUsed/heapLimit, NICHT heapUsed/heapTotal.
    mem: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, heapLimit: v8.getHeapStatistics().heap_size_limit, external: mem.external },
    procCpuPct,
    eventLoopLagMs: {
      mean: loopDelay.mean / 1e6,
      max: loopDelay.max / 1e6,
      p99: loopDelay.percentile(99) / 1e6,
    },
    activeResources: process.getActiveResourcesInfo ? process.getActiveResourcesInfo().length : null,
    sys: {
      hostname: os.hostname(),
      loadavg: os.loadavg(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
      hostCpuPct: hostCpuPercent(),
      memTotal: os.totalmem(),
      memFree: os.freemem(),
      sysUptimeSec: Math.floor(os.uptime()),
    },
    disk: { uploads: diskFor('/app/uploads'), root: diskFor('/') },
    ts: now,
  };
}

// ── Redis: heartbeat snapshot + event log ──────────────────────────────
async function publishSnapshot() {
  const r = getBusClient();
  if (!r) return;
  const snap = collectLocal();
  try {
    await r.set(`koro:status:${config.instanceId}`, JSON.stringify(snap), 'EX', 15);
    // Compact history point for sparklines (capped ring, ~60 pts = 5 min @ 5s).
    const pt = {
      t: snap.ts,
      cpu: snap.procCpuPct,
      heap: snap.mem.heapUsed / (snap.mem.heapLimit || snap.mem.heapTotal) * 100,
      lag: snap.eventLoopLagMs.p99,
      sockets: snap.ws.sockets,
      hostCpu: snap.sys.hostCpuPct,
    };
    await r.multi()
      .lpush(`koro:status:hist:${config.instanceId}`, JSON.stringify(pt))
      .ltrim(`koro:status:hist:${config.instanceId}`, 0, 59)
      .pexpire(`koro:status:hist:${config.instanceId}`, 120000)
      .exec();
  } catch { /* redis transient */ }
}

async function recordEvent(type, extra = {}) {
  const r = getBusClient();
  if (!r) return;
  const ev = JSON.stringify({ type, instance: config.instanceId, at: Date.now(), ...extra });
  try {
    await r.multi().lpush('koro:events', ev).ltrim('koro:events', 0, 199).exec();
  } catch { /* ignore */ }
}

let heartbeatTimer = null;
function startStatusHeartbeat() {
  recordEvent('boot', { version: config.build.commit });
  publishSnapshot();
  heartbeatTimer = setInterval(publishSnapshot, 5000);
  heartbeatTimer.unref();
}
function stopStatusHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// ── DB / Redis / git probes ────────────────────────────────────────────
async function pingDb() {
  const t0 = Date.now();
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) return { ok: false, latencyMs: Date.now() - t0, error: error.message };
    const counts = {};
    await Promise.all(['users', 'conversations', 'messages', 'devices', 'meetings'].map(async (tbl) => {
      try {
        const { count } = await supabase.from(tbl).select('*', { count: 'estimated', head: true });
        counts[tbl] = count;
      } catch { counts[tbl] = null; }
    }));
    return { ok: true, latencyMs: Date.now() - t0, counts };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: e.message };
  }
}

function parseRedisInfo(info) {
  const want = {
    redis_version: 'version',
    uptime_in_seconds: 'uptimeSec',
    connected_clients: 'clients',
    used_memory: 'usedMemory',
    used_memory_human: 'usedMemoryHuman',
    mem_fragmentation_ratio: 'fragRatio',
    total_commands_processed: 'totalCommands',
    instantaneous_ops_per_sec: 'opsPerSec',
    keyspace_hits: 'keyspaceHits',
    keyspace_misses: 'keyspaceMisses',
  };
  const out = {};
  for (const line of info.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    if (want[key]) out[want[key]] = line.slice(i + 1).trim();
  }
  return out;
}

async function probeRedis() {
  const r = getBusClient();
  if (!r) return { ok: false, error: 'REDIS_URL not configured (single-instance mode)' };
  try {
    const t0 = Date.now();
    await r.ping();
    const pingMs = Date.now() - t0;
    const info = await r.info();
    return { ok: true, pingMs, ...parseRedisInfo(info) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function gitLog() {
  return new Promise((resolve) => {
    const sep = '\x1f';
    execFile('git', [
      `--git-dir=${config.gitDir}`, 'log', '-30',
      `--pretty=format:%h${sep}%an${sep}%ad${sep}%s`, '--date=iso-strict',
    ], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows = stdout.split('\n').filter(Boolean).map((l) => {
        const [hash, author, date, subject] = l.split(sep);
        return { hash, author, date, subject };
      });
      resolve(rows);
    });
  });
}

async function collectAll() {
  const r = getBusClient();
  const local = collectLocal();
  const instances = { [local.instance]: local };

  if (r) {
    try {
      const keys = await r.keys('koro:status:*');
      if (keys.length) {
        const vals = await r.mget(keys);
        for (const v of vals) {
          if (!v) continue;
          try { const s = JSON.parse(v); instances[s.instance] = s; } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
  }

  let events = [];
  if (r) {
    try {
      const raw = await r.lrange('koro:events', 0, 49);
      events = raw.map((e) => { try { return JSON.parse(e); } catch { return null; } }).filter(Boolean);
    } catch { /* ignore */ }
  }

  // Per-instance sparkline history (oldest → newest for charting).
  const history = {};
  if (r) {
    await Promise.all(Object.keys(instances).map(async (inst) => {
      try {
        const raw = await r.lrange(`koro:status:hist:${inst}`, 0, 59);
        history[inst] = raw.map((p) => { try { return JSON.parse(p); } catch { return null; } }).filter(Boolean).reverse();
      } catch { history[inst] = []; }
    }));
  }

  const [redis, db, git, realtime, push, webhooks, audit, kpis, clients, dbDepth] = await Promise.all([
    probeRedis(), pingDb(), gitLog(),
    sd.collectRealtime(),
    Promise.resolve(sd.collectPush()),
    sd.collectWebhooks(),
    sd.collectAudit(),
    sd.collectKpis(),
    sd.collectClients(),
    sd.collectDbDepth(),
  ]);

  const presence = await sd.collectPresence(instances);
  const sessions = await sd.collectSessions();
  const turn = sd.collectTurn();
  const deploy = sd.collectDeploy(instances);
  const apm = sd.collectApm();
  const rateLimit = sd.rateLimitStats();
  const scheduler = sd.schedulerStats();
  const health = sd.computeHealth({ instances, redis, db, realtime, push, webhooks, scheduler, deploy, sessions });

  return {
    now: Date.now(),
    served_by: local.instance,
    instances,
    history,
    redis,
    db,
    events,
    git,
    realtime,
    presence,
    sessions,
    push,
    webhooks,
    audit,
    kpis,
    clients,
    turn,
    deploy,
    apm,
    rateLimit,
    scheduler,
    dbDepth,
    health,
  };
}

// ── HTTP: auth + handlers ──────────────────────────────────────────────
function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkAuth(req, res) {
  if (!config.statusPassword) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Status dashboard disabled (STATUS_PASSWORD not set)');
    return false;
  }
  const hdr = req.headers['authorization'] || '';
  const m = hdr.match(/^Basic\s+(.+)$/i);
  let pass = '';
  if (m) {
    try { pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':'); } catch { /* bad */ }
  }
  if (!pass || !constantTimeEqual(pass, config.statusPassword)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="koro status", charset="UTF-8"',
      'Content-Type': 'text/plain',
    });
    res.end('Authentication required');
    return false;
  }
  return true;
}

async function statusData(req, res) {
  if (!checkAuth(req, res)) return;
  let body;
  try { body = JSON.stringify(await collectAll()); }
  catch (e) { body = JSON.stringify({ error: e.message }); }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function statusPage(req, res) {
  if (!checkAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE_HTML);
}

// Feature flags read (for the actions tab). Same Basic-auth gate.
async function statusFlags(req, res) {
  if (!checkAuth(req, res)) return;
  let flags = [];
  try {
    const { data } = await supabase.from('feature_flags').select('key, rollout, percent, description, updated_at').order('key');
    flags = data || [];
  } catch { /* ignore */ }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ flags }));
}

// Action dispatch (retry webhooks / revoke device / set flag). Same gate.
async function statusActionHandler(req, res, { params }) {
  if (!checkAuth(req, res)) return;
  const { statusAction } = require('./statusActions');
  await statusAction(req, res, params.name);
}

// ── The dashboard (self-contained, polls /status/data) ─────────────────
const PAGE_HTML = require("node:fs").readFileSync(require("node:path").join(__dirname, "statusPage.html"), "utf8");

module.exports = { statusPage, statusData, statusFlags, statusActionHandler, startStatusHeartbeat, stopStatusHeartbeat, recordEvent };
