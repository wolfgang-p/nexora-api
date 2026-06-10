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
  try {
    await r.set(`koro:status:${config.instanceId}`, JSON.stringify(collectLocal()), 'EX', 15);
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

  const [redis, db, git] = await Promise.all([probeRedis(), pingDb(), gitLog()]);

  return {
    now: Date.now(),
    served_by: local.instance,
    instances,
    redis,
    db,
    events,
    git,
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

// ── The dashboard (self-contained, polls /status/data) ─────────────────
const PAGE_HTML = `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>koro · status</title>
<style>
:root{--bg:#0b0f15;--card:#141b26;--card2:#1b2533;--line:#243043;--tx:#e6edf6;--mut:#8aa0bd;--ok:#3fb950;--warn:#d29922;--err:#f85149;--accent:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:14px;padding:16px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,15,21,.92);backdrop-filter:blur(6px);z-index:5}
header h1{font-size:17px;margin:0;letter-spacing:.5px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot.ok{background:var(--ok);box-shadow:0 0 8px var(--ok)}.dot.err{background:var(--err);box-shadow:0 0 8px var(--err)}.dot.warn{background:var(--warn)}
.muted{color:var(--mut)}.right{margin-left:auto;display:flex;gap:18px;align-items:center;font-size:12px}
.wrap{padding:22px;max-width:1400px;margin:0 auto}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.card h2{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--mut);display:flex;align-items:center;gap:8px}
.kv{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dashed var(--line)}
.kv:last-child{border-bottom:0}.kv .k{color:var(--mut)}.kv .v{font-variant-numeric:tabular-nums;text-align:right}
.bar{height:7px;border-radius:5px;background:var(--card2);overflow:hidden;margin-top:5px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#1f6feb)}
.bar.hot>i{background:linear-gradient(90deg,var(--warn),var(--err))}
.inst{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.5px;font-size:11px}
td.mono,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.tag{font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid var(--line);color:var(--mut)}
.tag.boot{color:var(--accent);border-color:var(--accent)}.tag.deploy{color:var(--ok);border-color:var(--ok)}.tag.shutdown{color:var(--warn);border-color:var(--warn)}
.big{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.sub{font-size:11px;color:var(--mut)}
.full{grid-column:1/-1}
.flex{display:flex;gap:18px;flex-wrap:wrap}
.metric{flex:1;min-width:120px}
.err-txt{color:var(--err)}.ok-txt{color:var(--ok)}
#err{display:none;background:var(--err);color:#fff;padding:8px 14px;border-radius:8px;margin-bottom:14px}
</style></head>
<body>
<header>
  <span class="dot ok" id="hdrdot"></span>
  <h1>KORO · SYSTEM STATUS</h1>
  <div class="right">
    <span class="muted">served by <b id="servedby" class="mono">–</b></span>
    <span class="muted">aktualisiert <b id="updated">–</b></span>
    <label class="muted"><input type="checkbox" id="auto" checked> auto</label>
  </div>
</header>
<div class="wrap">
  <div id="err"></div>
  <div class="grid" style="margin-bottom:16px">
    <div class="card"><h2>API Instanzen</h2><div id="apisum" class="flex"></div></div>
    <div class="card"><h2><span class="dot" id="redisdot"></span> Redis</h2><div id="redis"></div></div>
    <div class="card"><h2><span class="dot" id="dbdot"></span> Datenbank</h2><div id="db"></div></div>
    <div class="card"><h2>Host Auslastung</h2><div id="host"></div></div>
  </div>
  <div class="card full" style="margin-bottom:16px"><h2>Instanz-Details (blue / green)</h2><div class="inst" id="instances"></div></div>
  <div class="grid">
    <div class="card"><h2>Event- / Restart-Log</h2><div id="events"></div></div>
    <div class="card"><h2>Git- / Deploy-Historie</h2><div id="git"></div></div>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);
const fmtBytes=n=>{if(n==null)return'–';const u=['B','KB','MB','GB','TB'];let i=0;n=+n;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i]};
const fmtDur=s=>{if(s==null)return'–';s=Math.floor(s);const d=Math.floor(s/86400);s%=86400;const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);return(d?d+'d ':'')+(h?h+'h ':'')+(d?'':m+'m '+(h?'':(s%60)+'s')).trim()||'0s'};
const ago=ms=>{const s=Math.floor((Date.now()-ms)/1000);if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return Math.floor(s/86400)+'d'};
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const kv=(k,v)=>'<div class="kv"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>';
const bar=(pct,hot)=>'<div class="bar'+(hot?' hot':'')+'"><i style="width:'+Math.min(100,Math.max(0,pct)).toFixed(1)+'%"></i></div>';

async function load(){
  try{
    const r=await fetch('/status/data',{cache:'no-store'});
    if(r.status===401){location.reload();return}
    if(!r.ok)throw new Error('HTTP '+r.status);
    const d=await r.json();
    render(d); $('err').style.display='none';
  }catch(e){ $('err').textContent='Fehler beim Laden: '+e.message; $('err').style.display='block'; $('hdrdot').className='dot err'; }
}

function render(d){
  $('servedby').textContent=d.served_by||'–';
  $('updated').textContent=new Date(d.now).toLocaleTimeString('de-DE');
  const insts=Object.values(d.instances||{}).sort((a,b)=>(a.instance>b.instance?1:-1));
  const allOk=insts.length>0 && d.redis && d.db && d.db.ok;
  $('hdrdot').className='dot '+(d.db&&d.db.ok&&insts.length?'ok':'warn');

  // API summary
  $('apisum').innerHTML=insts.map(i=>{
    const stale=(Date.now()-i.ts)>20000;
    return '<div class="metric"><div class="big">'+(stale?'<span class="err-txt">offline</span>':'<span class="ok-txt">●</span> '+esc(i.instance))+'</div>'+
      '<div class="sub">up '+fmtDur(i.uptimeSec)+' · '+esc((i.version||'').slice(0,7))+'</div>'+
      '<div class="sub">'+i.ws.sockets+' sockets / '+i.ws.devices+' devices</div></div>';
  }).join('')||'<span class="muted">keine Instanz gemeldet</span>';

  // Redis
  $('redisdot').className='dot '+(d.redis&&d.redis.ok?'ok':'err');
  $('redis').innerHTML=d.redis&&d.redis.ok
    ? kv('Status','<span class="ok-txt">verbunden</span>')+kv('Ping',d.redis.pingMs+' ms')+kv('Version',esc(d.redis.version))
      +kv('Clients',d.redis.clients)+kv('Speicher',esc(d.redis.usedMemoryHuman))+kv('Ops/s',d.redis.opsPerSec)
      +kv('Befehle ges.',(+d.redis.totalCommands).toLocaleString('de-DE'))+kv('Uptime',fmtDur(+d.redis.uptimeSec))
    : '<span class="err-txt">'+esc(d.redis?d.redis.error:'n/a')+'</span>';

  // DB
  $('dbdot').className='dot '+(d.db&&d.db.ok?'ok':'err');
  if(d.db&&d.db.ok){
    let h=kv('Status','<span class="ok-txt">erreichbar</span>')+kv('Latenz',d.db.latencyMs+' ms');
    for(const [t,c] of Object.entries(d.db.counts||{})) h+=kv('~'+t,c==null?'–':(+c).toLocaleString('de-DE'));
    $('db').innerHTML=h;
  } else $('db').innerHTML='<span class="err-txt">'+esc(d.db?d.db.error:'n/a')+'</span>';

  // Host (from first fresh instance — same kernel)
  const h=insts.find(i=>(Date.now()-i.ts)<20000)||insts[0];
  if(h){
    const s=h.sys, memUsed=s.memTotal-s.memFree, memPct=memUsed/s.memTotal*100;
    const up=h.disk&&h.disk.uploads;
    $('host').innerHTML=
      kv('Host',esc(s.hostname))+
      kv('CPU',s.cpuPct!=null?'':'')+
      '<div class="kv"><span class="k">CPU ('+s.cpus+' cores)</span><span class="v">'+s.hostCpuPct.toFixed(1)+'%</span></div>'+bar(s.hostCpuPct,s.hostCpuPct>85)+
      '<div class="kv"><span class="k">RAM</span><span class="v">'+fmtBytes(memUsed)+' / '+fmtBytes(s.memTotal)+'</span></div>'+bar(memPct,memPct>90)+
      kv('Load (1/5/15)',s.loadavg.map(x=>x.toFixed(2)).join(' / '))+
      (up?'<div class="kv"><span class="k">Disk (uploads)</span><span class="v">'+fmtBytes(up.used)+' / '+fmtBytes(up.total)+'</span></div>'+bar(up.usedPct,up.usedPct>90):'')+
      kv('Host-Uptime',fmtDur(s.sysUptimeSec));
  }

  // Instance detail
  $('instances').innerHTML=insts.map(i=>{
    const stale=(Date.now()-i.ts)>20000;
    // Auslastung am ECHTEN V8-Limit messen (heapLimit), nicht am aktuell
    // reservierten heapTotal — sonst zeigt der Balken dauernd ~100 %, obwohl
    // massig Luft ist. Fallback auf heapTotal für alte Snapshots ohne heapLimit.
    const heapMax=i.mem.heapLimit||i.mem.heapTotal;
    const heapPct=i.mem.heapUsed/heapMax*100;
    return '<div class="card2 card" style="background:var(--card2)">'+
      '<h2 style="color:var(--tx)"><span class="dot '+(stale?'err':'ok')+'"></span> '+esc(i.instance)+' <span class="tag mono">'+esc((i.version||'').slice(0,7))+'</span></h2>'+
      kv('PID',i.pid)+kv('Uptime',fmtDur(i.uptimeSec))+kv('Node',esc(i.node))+
      kv('Proz. CPU',i.procCpuPct.toFixed(1)+'%')+
      kv('RSS',fmtBytes(i.mem.rss))+
      '<div class="kv"><span class="k">Heap</span><span class="v">'+fmtBytes(i.mem.heapUsed)+' / '+fmtBytes(heapMax)+' <span class="mono" style="opacity:.6">(res '+fmtBytes(i.mem.heapTotal)+')</span></span></div>'+bar(heapPct,heapPct>90)+
      kv('Event-Loop Lag','x̄ '+i.eventLoopLagMs.mean.toFixed(1)+' / p99 '+i.eventLoopLagMs.p99.toFixed(1)+' / max '+i.eventLoopLagMs.max.toFixed(0)+' ms')+
      kv('WS sockets/devices',i.ws.sockets+' / '+i.ws.devices)+
      kv('Peer-Instanzen',i.ws.peerInstances+' ('+i.ws.remoteDevices+' remote dev)')+
      kv('Aktive Handles',i.activeResources==null?'–':i.activeResources)+
      kv('Letzter Beat',ago(i.ts)+' her')+
      '</div>';
  }).join('')||'<span class="muted">–</span>';

  // Events
  $('events').innerHTML='<table><thead><tr><th>Zeit</th><th>Event</th><th>Instanz</th><th>Info</th></tr></thead><tbody>'+
    (d.events||[]).map(e=>'<tr><td class="muted">'+ago(e.at)+' her</td><td><span class="tag '+esc(e.type)+'">'+esc(e.type)+'</span></td><td class="mono">'+esc(e.instance)+'</td><td class="mono">'+esc(e.commit?e.commit+' '+(e.subject||''):(e.version||''))+'</td></tr>').join('')+
    '</tbody></table>'+((d.events||[]).length?'':'<span class="muted">keine Events</span>');

  // Git
  $('git').innerHTML='<table><thead><tr><th>Commit</th><th>Autor</th><th>Datum</th><th>Nachricht</th></tr></thead><tbody>'+
    (d.git||[]).map(g=>'<tr><td class="mono">'+esc(g.hash)+'</td><td>'+esc(g.author)+'</td><td class="muted">'+esc((g.date||'').slice(0,16).replace('T',' '))+'</td><td>'+esc(g.subject)+'</td></tr>').join('')+
    '</tbody></table>'+((d.git||[]).length?'':'<span class="muted">.git nicht gemountet</span>');
}

let timer=null;
function tick(){ if($('auto').checked) load(); }
$('auto').addEventListener('change',()=>{ if($('auto').checked)load(); });
load(); timer=setInterval(tick,5000);
</script>
</body></html>`;

module.exports = { statusPage, statusData, startStatusHeartbeat, stopStatusHeartbeat, recordEvent };
