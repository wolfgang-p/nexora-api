'use strict';

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');

/**
 * Authed CRUD for inbound webhooks. Owner/admin of the conversation
 * (or the workspace) can create + revoke. The token is shown ONCE on
 * creation and never again.
 */

const PROVIDERS = ['github', 'linear', 'sentry', 'zapier', 'generic'];

async function ensureAdmin(req, conversationId) {
  const { data: m } = await supabase.from('conversation_members')
    .select('role').eq('conversation_id', conversationId)
    .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!m) return false;
  return m.role === 'owner' || m.role === 'admin';
}

async function list(req, res, { params }) {
  if (!(await ensureAdmin(req, params.id))) return forbidden(res);
  const { data, error } = await supabase.from('inbound_webhooks')
    .select('id, name, provider, active, last_received_at, receive_count, created_at, created_by')
    .eq('conversation_id', params.id)
    .order('created_at', { ascending: false });
  if (error) return serverError(res, 'Query failed', error);
  ok(res, { hooks: data || [] });
}

async function create(req, res, { params }) {
  if (!(await ensureAdmin(req, params.id))) return forbidden(res);
  const body = await readJson(req).catch(() => null);
  if (!body?.name) return badRequest(res, 'name required');
  const provider = PROVIDERS.includes(body.provider) ? body.provider : 'generic';
  const useHmac = !!body.use_hmac;
  const token = 'koro_in_' + crypto.randomBytes(20).toString('base64url');
  const hmacSecret = useHmac ? crypto.randomBytes(32).toString('base64url') : null;

  // Resolve workspace_id from the conversation for retention / scoping.
  const { data: conv } = await supabase.from('conversations')
    .select('workspace_id').eq('id', params.id).maybeSingle();

  const { data, error } = await supabase.from('inbound_webhooks').insert({
    workspace_id: conv?.workspace_id || null,
    conversation_id: params.id,
    created_by: req.auth.userId,
    name: String(body.name).slice(0, 80),
    token,
    hmac_secret: hmacSecret,
    provider,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'webhook.in.create', targetType: 'inbound_webhook', targetId: data.id,
    metadata: { provider, conversation_id: params.id }, req,
  });

  // Token + secret returned ONCE.
  created(res, {
    hook: {
      id: data.id, name: data.name, provider: data.provider,
      created_at: data.created_at,
    },
    url: `/hooks/in/${token}`,
    hmac_secret: hmacSecret,
  });
}

async function destroy(req, res, { params }) {
  const { data: hook } = await supabase.from('inbound_webhooks')
    .select('conversation_id').eq('id', params.hook_id).maybeSingle();
  if (!hook) return notFound(res);
  if (!(await ensureAdmin(req, hook.conversation_id))) return forbidden(res);
  await supabase.from('inbound_webhooks').update({ active: false }).eq('id', params.hook_id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'webhook.in.revoke', targetType: 'inbound_webhook', targetId: params.hook_id, req,
  });
  ok(res, { ok: true });
}

module.exports = { list, create, destroy };
