'use strict';

const { supabase } = require('../db/supabase');
const { hmac } = require('../util/crypto');

/**
 * Background retry worker for failed webhook deliveries.
 *
 * Scans webhook_deliveries for rows where delivered_at IS NULL and attempts
 * a re-send with exponential backoff. Caps retries and marks giveUp.
 *
 * Backoff schedule (minutes after created_at): 1, 5, 15, 60, 240, 1440.
 * Max 6 attempts total (1 original + 5 retries). After that we stop.
 */

const BACKOFF_MIN = [1, 5, 15, 60, 240, 1440];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const TICK_MS = 30_000;

let running = false;
let timer = null;

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  // Kick once immediately
  tick().catch((e) => console.error('[webhook-worker]', e));
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick() {
  if (running) return;
  running = true;
  try { await drainOnce(); }
  catch (err) { console.error('[webhook-worker] tick failed:', err); }
  finally { running = false; }
}

async function drainOnce() {
  // Pull a batch of pending deliveries
  const { data: pendings, error } = await supabase
    .from('webhook_deliveries')
    .select('id, webhook_id, event, payload, attempt, created_at')
    .is('delivered_at', null)
    .lt('attempt', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) { console.error('[webhook-worker]', error); return; }
  if (!pendings?.length) return;

  const now = Date.now();

  for (const d of pendings) {
    const age = (now - new Date(d.created_at).getTime()) / 60_000;
    const wantedIdx = Math.min(d.attempt, BACKOFF_MIN.length) - 1;
    const nextAt = wantedIdx >= 0 ? BACKOFF_MIN[wantedIdx] : 0;
    if (age < nextAt) continue;

    // Fetch the hook config
    const { data: hook } = await supabase.from('webhooks')
      .select('id, url, secret, active').eq('id', d.webhook_id).maybeSingle();
    if (!hook || !hook.active) {
      await supabase.from('webhook_deliveries').update({ attempt: MAX_ATTEMPTS })
        .eq('id', d.id);
      continue;
    }

    await attemptDelivery(hook, d);
  }
}

async function attemptDelivery(hook, delivery) {
  const body = JSON.stringify({ event: delivery.event, ...delivery.payload });
  const sig = hmac(hook.secret, body);

  let status = 0;
  let responseBody = null;
  try {
    const r = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Koro-Event': delivery.event,
        'X-Koro-Signature': `sha256=${sig}`,
        'X-Koro-Delivery': delivery.id,
        'X-Koro-Attempt': String(delivery.attempt + 1),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = r.status;
    responseBody = (await r.text()).slice(0, 2000);
  } catch (err) {
    responseBody = String(err?.message || err).slice(0, 2000);
  }

  const success = status >= 200 && status < 300;
  await supabase.from('webhook_deliveries').update({
    response_status: status || null,
    response_body: responseBody,
    attempt: delivery.attempt + 1,
    delivered_at: success ? new Date().toISOString() : null,
  }).eq('id', delivery.id);

  if (success) {
    await supabase.from('webhooks').update({
      last_success_at: new Date().toISOString(),
      failure_count: 0,
    }).eq('id', hook.id);
  } else {
    await supabase.from('webhooks').update({
      last_failure_at: new Date().toISOString(),
    }).eq('id', hook.id);
  }
}

module.exports = { start, stop };
