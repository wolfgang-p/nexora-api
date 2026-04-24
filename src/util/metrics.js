'use strict';

/**
 * Lightweight in-process metrics. Exposed both via `GET /metrics` in
 * Prometheus text format (scrape target) and via the admin stats JSON
 * dashboard.
 *
 * Purposefully minimal — no external dep. If we outgrow this, swap for
 * `prom-client`. The surface stays the same (`counter()` / `observe()` /
 * `metricsSnapshot()` / `prometheusText()`) so the swap is local.
 */

const counters = new Map();        // name → number
const statusCounters = new Map();  // `${status}` → number (http responses)
const histograms = new Map();      // name → { count, sum, buckets: [le,count][] }

function counter(name, delta = 1, labels) {
  const key = labels ? `${name}{${serializeLabels(labels)}}` : name;
  counters.set(key, (counters.get(key) || 0) + delta);
}

function httpResponse(status) {
  const key = `http_responses_total{status="${status}"}`;
  statusCounters.set(key, (statusCounters.get(key) || 0) + 1);
}

/** O(1) observation; default buckets mimic prom-client defaults in seconds. */
const DEFAULT_BUCKETS_SEC = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function observe(name, value, bucketsSec = DEFAULT_BUCKETS_SEC) {
  let h = histograms.get(name);
  if (!h) {
    h = { count: 0, sum: 0, buckets: bucketsSec.map((le) => [le, 0]) };
    histograms.set(name, h);
  }
  h.count += 1;
  h.sum += value;
  for (const b of h.buckets) if (value <= b[0]) b[1] += 1;
}

function serializeLabels(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
}

/** JSON snapshot for the admin dashboard. */
function metricsSnapshot() {
  const c = {};
  for (const [k, v] of counters) c[k] = v;
  for (const [k, v] of statusCounters) c[k] = v;
  const h = {};
  for (const [k, v] of histograms) h[k] = { count: v.count, sum: v.sum };
  return { counters: c, histograms: h };
}

/** Prometheus text exposition. */
function prometheusText() {
  const lines = [];
  for (const [k, v] of counters) lines.push(`${k} ${v}`);
  for (const [k, v] of statusCounters) lines.push(`${k} ${v}`);
  for (const [name, h] of histograms) {
    for (const [le, count] of h.buckets) {
      lines.push(`${name}_bucket{le="${le}"} ${count}`);
    }
    lines.push(`${name}_bucket{le="+Inf"} ${h.count}`);
    lines.push(`${name}_count ${h.count}`);
    lines.push(`${name}_sum ${h.sum}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { counter, httpResponse, observe, metricsSnapshot, prometheusText };
