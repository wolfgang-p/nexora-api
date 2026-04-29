'use strict';

/**
 * Inbound-webhook receiver.
 *
 *   POST /hooks/in/:token
 *
 * Public, unauthenticated (other than the unguessable token in the URL
 * + an optional HMAC). When a vendor (GitHub, Linear, Sentry, Zapier)
 * posts a JSON payload, we render a system-message into the bound
 * conversation. Provider-specific shaping turns the payload into a
 * one-line headline + a short body the bot pastes verbatim.
 *
 * E2E note: bot messages can't be sealed per-recipient because no
 * device pre-shared a key with "the bot". We therefore use the
 * `kind='system'` envelope, whose payload is a JSON struct that lives
 * in plaintext on the server — the contract for system messages.
 *
 * Authed admin CRUD lives in src/webhooks/inbound_admin.js.
 */

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { broadcastToDevices } = require('../ws/dispatch');
const { hit, check, send429, clientIp } = require('../middleware/rateLimit');

async function receive(req, res, { params }) {
  // Token-bucket: 60 events/min per token. Anything wilder is almost
  // certainly a misconfigured polling integration; refuse and let the
  // sender back off.
  const ip = clientIp(req);
  const tokenKey = `hook-in:${params.token}`;
  if (!check(tokenKey, 60, 60)) return send429(res);
  hit(tokenKey);
  hit(`hook-in:ip:${ip}`);

  const { data: hook } = await supabase.from('inbound_webhooks')
    .select('*').eq('token', params.token).maybeSingle();
  if (!hook || !hook.active) return notFound(res, 'Hook not found');

  const raw = await rawBody(req);
  if (!raw) return badRequest(res, 'Empty body');

  // Optional HMAC verification. Each provider signs differently; we
  // support the most common ones out of the box.
  if (hook.hmac_secret) {
    if (!verifySignature(req, raw, hook.hmac_secret, hook.provider)) {
      return res.writeHead(401, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: 'Bad signature' }),
      );
    }
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf-8')); }
  catch { return badRequest(res, 'Body must be JSON'); }

  const summary = formatPayload(hook.provider, payload, req.headers);

  // Insert as a system-message in the bound conversation.
  const { data: msg, error } = await supabase.from('messages').insert({
    conversation_id: hook.conversation_id,
    sender_user_id: hook.created_by,
    sender_device_id: null,
    kind: 'system',
    system_payload: {
      action: 'bot_post',
      bot: { name: hook.name, provider: hook.provider || 'generic' },
      title: summary.title,
      body: summary.body,
      url: summary.url || null,
    },
  }).select('*').single();
  if (error) return serverError(res, 'Could not deliver hook', error);

  // No per-recipient ciphertext for system messages — the payload IS
  // the message, by design.
  // WS broadcast so live members refresh.
  const { data: members } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', hook.conversation_id).is('left_at', null);
  const userIds = (members || []).map((m) => m.user_id);
  const { data: devs } = await supabase.from('devices').select('id')
    .in('user_id', userIds).is('revoked_at', null);
  broadcastToDevices((devs || []).map((d) => d.id), () => ({
    type: 'message.new',
    message: {
      id: msg.id,
      conversation_id: msg.conversation_id,
      sender_user_id: msg.sender_user_id,
      sender_device_id: null,
      kind: 'system',
      system_payload: msg.system_payload,
      created_at: msg.created_at,
      reply_to_message_id: null,
      thread_root_id: null,
    },
    ciphertext: null, nonce: null,
  }));

  await supabase.from('inbound_webhooks').update({
    last_received_at: new Date().toISOString(),
    receive_count: (hook.receive_count || 0) + 1,
  }).eq('id', hook.id);

  audit({
    action: 'webhook.in.received',
    targetType: 'inbound_webhook', targetId: hook.id,
    metadata: { provider: hook.provider, title: summary.title }, req,
    workspaceId: hook.workspace_id,
  });

  ok(res, { ok: true });
}

function rawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      // 256 KB hard cap — vendor payloads are typically < 32 KB.
      if (chunks.reduce((n, c2) => n + c2.length, 0) > 256 * 1024) {
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function verifySignature(req, raw, secret, provider) {
  switch (provider) {
    case 'github': {
      const got = req.headers['x-hub-signature-256'] || '';
      const want = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
      return constTimeEq(got, want);
    }
    case 'linear':
    case 'sentry': {
      const got = req.headers['x-linear-signature'] || req.headers['sentry-hook-signature'] || '';
      const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      return constTimeEq(got, want);
    }
    default: {
      const got = req.headers['x-koro-signature'] || '';
      const want = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
      return constTimeEq(got, want);
    }
  }
}

function constTimeEq(a, b) {
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  catch { return false; }
}

/**
 * Provider-specific summarizers. Returns {title, body, url}.
 * Anything not in the switch falls through to a "Generic JSON" line.
 */
function formatPayload(provider, p, headers) {
  switch (provider) {
    case 'github': {
      const event = headers['x-github-event'];
      if (event === 'push' && p?.head_commit) {
        return {
          title: `🔧 ${p.repository?.full_name}: ${p.head_commit.message.split('\n')[0]}`,
          body: `${p.pusher?.name || 'someone'} pushed to ${p.ref?.replace('refs/heads/', '') || 'main'}`,
          url: p.head_commit.url,
        };
      }
      if (event === 'pull_request' && p?.pull_request) {
        return {
          title: `🔀 PR ${p.action}: ${p.pull_request.title}`,
          body: `${p.repository?.full_name}#${p.pull_request.number} by @${p.pull_request.user?.login}`,
          url: p.pull_request.html_url,
        };
      }
      if (event === 'issues' && p?.issue) {
        return {
          title: `🐛 Issue ${p.action}: ${p.issue.title}`,
          body: `${p.repository?.full_name}#${p.issue.number}`,
          url: p.issue.html_url,
        };
      }
      return { title: `GitHub: ${event || 'event'}`, body: p?.repository?.full_name || '' };
    }
    case 'linear': {
      const action = p?.action;
      const data = p?.data;
      if (action && data?.title) {
        return {
          title: `📋 Linear ${action}: ${data.title}`,
          body: `${data.team?.name || ''}${data.assignee ? ' — ' + data.assignee.name : ''}`,
          url: data.url,
        };
      }
      return { title: 'Linear-Update', body: '' };
    }
    case 'sentry': {
      if (p?.event?.title) {
        return {
          title: `🚨 ${p.event.title}`,
          body: `${p.project_name || ''} · ${p.event.environment || ''}`,
          url: p.url,
        };
      }
      return { title: 'Sentry-Event', body: '' };
    }
    default: {
      // Generic — pull a "title" / "text" / "summary" if present, else
      // dump the first ~120 chars of the JSON.
      const t = p?.title || p?.text || p?.summary || JSON.stringify(p).slice(0, 120);
      return { title: String(t).slice(0, 200), body: '' };
    }
  }
}

module.exports = { receive };
