'use strict';

/**
 * Event producer. Callers pass `{ event, workspaceId?, payload }` and we:
 *   1. Mirror into webhook_event_log (capped; trimmed on a schedule) so
 *      the admin UI can browse recent fires.
 *   2. Materialize a `webhook_deliveries` row for every matching webhook.
 *      The retry worker picks these up on its next 30-s tick.
 *
 * Matching rule: a webhook matches when its `events` array is NULL / empty
 * (wildcard) or contains the event name.
 *
 * Fire-and-forget: any error is logged and swallowed — a subscriber
 * pipeline hiccup must never break message send.
 */

const { supabase } = require('../db/supabase');
const logger = require('../util/logger');
const log = logger.child('webhooks.dispatcher');

const SUPPORTED_EVENTS = new Set([
  'message.new',
  'message.edited',
  'message.deleted',
  'call.started',
  'call.ended',
  'task.created',
  'task.updated',
  'task.completed',
  'user.joined_workspace',
  'user.left_workspace',
  'workspace.created',
  'conversation.created',
  'conversation.member_added',
]);

async function emit({ event, workspaceId = null, payload }) {
  if (!SUPPORTED_EVENTS.has(event)) {
    log.warn('unknown event', event);
    return;
  }

  supabase.from('webhook_event_log').insert({
    event, workspace_id: workspaceId, payload,
  }).then(() => {}, (err) => log.warn('event_log insert', err?.message));

  let qb = supabase.from('webhooks')
    .select('id, events, workspace_id')
    .eq('active', true);
  if (workspaceId) qb = qb.eq('workspace_id', workspaceId);

  const { data: hooks, error } = await qb;
  if (error) { log.warn('hooks lookup', error?.message); return; }
  if (!hooks || hooks.length === 0) return;

  const rows = [];
  for (const h of hooks) {
    const matches = !h.events || h.events.length === 0 || h.events.includes(event);
    if (!matches) continue;
    rows.push({ webhook_id: h.id, event, payload, attempt: 0 });
  }
  if (rows.length === 0) return;

  const { error: insErr } = await supabase.from('webhook_deliveries').insert(rows);
  if (insErr) log.warn('deliveries insert', insErr?.message);
}

module.exports = { emit, SUPPORTED_EVENTS };
