'use strict';

const { supabase } = require('../db/supabase');
const { hmac } = require('../util/crypto');

/**
 * Fire a webhook event to all subscribers of a workspace.
 *
 * Payload by convention contains only metadata (no plaintext). If the hook
 * is tied to a crm_seat device, the caller may include per-device ciphertext
 * separately; that extension point isn't implemented here.
 *
 * Best-effort. Persists attempts into webhook_deliveries for retries.
 */
async function dispatch(workspaceId, event, payload) {
  const { data: hooks } = await supabase
    .from('webhooks')
    .select('id, url, secret, events, active')
    .eq('workspace_id', workspaceId)
    .eq('active', true);
  if (!hooks?.length) return;

  for (const h of hooks) {
    if (!h.events.includes(event) && !h.events.includes('*')) continue;
    deliver(h, event, payload).catch((err) => console.error('[webhook]', err.message));
  }
}

async function deliver(hook, event, payload) {
  const body = JSON.stringify({ event, ...payload });
  const sig = hmac(hook.secret, body);

  let status = 0;
  let responseBody = null;
  try {
    const r = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Koro-Event': event,
        'X-Koro-Signature': `sha256=${sig}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = r.status;
    responseBody = (await r.text()).slice(0, 2000);
  } catch (err) {
    responseBody = String(err?.message || err).slice(0, 2000);
  }

  await supabase.from('webhook_deliveries').insert({
    webhook_id: hook.id,
    event, payload,
    response_status: status || null,
    response_body: responseBody,
    delivered_at: status >= 200 && status < 300 ? new Date().toISOString() : null,
  });

  if (status >= 200 && status < 300) {
    await supabase.from('webhooks').update({
      last_success_at: new Date().toISOString(), failure_count: 0,
    }).eq('id', hook.id);
  } else {
    await supabase.from('webhooks').update({
      last_failure_at: new Date().toISOString(),
      failure_count: supabase.raw ? supabase.raw('failure_count + 1') : undefined,
    }).eq('id', hook.id);
  }
}

module.exports = { dispatch };
