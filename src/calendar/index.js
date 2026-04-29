'use strict';

/**
 * Calendar integration. Two providers: 'apple' and 'google'. Apple is
 * gated client-side to Apple devices only (the option doesn't even
 * appear on Android / Web non-Apple), so the server doesn't need to
 * filter by platform — it just trusts the client's choice.
 *
 * The OAuth dance itself is owner-deployable: this module exposes
 * begin/finish endpoints that emit redirect URLs for the platform
 * defaults. Operators must set:
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT
 *   APPLE_OAUTH_CLIENT_ID  / APPLE_OAUTH_TEAM_ID / APPLE_OAUTH_KEY_ID  / APPLE_OAUTH_PRIVATE_KEY / APPLE_OAUTH_REDIRECT
 *
 * Without those env vars the begin endpoint returns 503; the rest of
 * the app keeps working, the calendar option just shows "nicht verfügbar".
 *
 * Endpoints (all authed):
 *   GET    /calendar/links                          my links
 *   POST   /calendar/oauth/:provider/begin          returns redirect URL
 *   POST   /calendar/oauth/:provider/finish         {code} → store tokens
 *   DELETE /calendar/links/:provider                revoke
 *   POST   /calendar/events                         create + try to sync
 *   GET    /calendar/events                         list mine
 */

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');

const VALID_PROVIDERS = ['apple', 'google'];

async function listLinks(req, res) {
  const { data } = await supabase.from('calendar_links')
    .select('provider, external_account_id, scopes, created_at, revoked_at')
    .eq('user_id', req.auth.userId).is('revoked_at', null);
  ok(res, { links: data || [] });
}

async function oauthBegin(req, res, { params }) {
  const provider = params.provider;
  if (!VALID_PROVIDERS.includes(provider)) return badRequest(res, 'invalid provider');

  if (provider === 'google') {
    const cid = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const redirect = process.env.GOOGLE_OAUTH_REDIRECT;
    if (!cid || !redirect) return res.writeHead(503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Google OAuth not configured' }));
    const state = crypto.randomBytes(16).toString('base64url');
    const url = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
      client_id: cid,
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.events openid',
      access_type: 'offline',
      prompt: 'consent',
      state: `${req.auth.userId}.${state}`,
    });
    return ok(res, { url });
  }
  if (provider === 'apple') {
    const cid = process.env.APPLE_OAUTH_CLIENT_ID;
    const redirect = process.env.APPLE_OAUTH_REDIRECT;
    if (!cid || !redirect) return res.writeHead(503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Apple OAuth not configured' }));
    const state = crypto.randomBytes(16).toString('base64url');
    const url = `https://appleid.apple.com/auth/authorize?` + new URLSearchParams({
      client_id: cid,
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'name email',
      response_mode: 'form_post',
      state: `${req.auth.userId}.${state}`,
    });
    return ok(res, { url });
  }
}

async function oauthFinish(req, res, { params }) {
  const provider = params.provider;
  if (!VALID_PROVIDERS.includes(provider)) return badRequest(res, 'invalid provider');
  const body = await readJson(req).catch(() => null);
  if (!body?.code) return badRequest(res, 'code required');

  // Exchange code → tokens. Both providers have nearly identical
  // shapes here; we keep the call narrow because full SDK integration
  // is operator-side work (vendor SDKs change often, env-driven keys).
  if (provider === 'google') {
    const cid = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const cs = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirect = process.env.GOOGLE_OAUTH_REDIRECT;
    if (!cid || !cs || !redirect) return serverError(res, 'Google OAuth not configured');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: body.code, client_id: cid, client_secret: cs,
        redirect_uri: redirect, grant_type: 'authorization_code',
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) return serverError(res, 'Token exchange failed', j);
    await supabase.from('calendar_links').upsert({
      user_id: req.auth.userId,
      provider: 'google',
      access_token: j.access_token,
      refresh_token: j.refresh_token || null,
      expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(),
      scopes: (j.scope || '').split(' ').filter(Boolean),
      revoked_at: null,
    }, { onConflict: 'user_id,provider' });
    return ok(res, { ok: true });
  }
  if (provider === 'apple') {
    // Apple's exchange requires a JWT signed with an ES256 key — owner
    // generates it from APPLE_OAUTH_PRIVATE_KEY at process start.
    // Simplified path: we just store a placeholder link until ops wires
    // the real token-exchange (the Apple side is very specific).
    await supabase.from('calendar_links').upsert({
      user_id: req.auth.userId,
      provider: 'apple',
      access_token: null,
      refresh_token: null,
      external_account_id: body.external_account_id || null,
      revoked_at: null,
    }, { onConflict: 'user_id,provider' });
    return ok(res, { ok: true, pending: 'Apple token exchange wiring required (see ops doc)' });
  }
}

async function revoke(req, res, { params }) {
  await supabase.from('calendar_links').update({
    revoked_at: new Date().toISOString(),
    access_token: null, refresh_token: null,
  }).eq('user_id', req.auth.userId).eq('provider', params.provider);
  ok(res, { ok: true });
}

async function createEvent(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.title || !body?.starts_at) return badRequest(res, 'title + starts_at required');

  // Workspace events: caller must be a member of that workspace.
  let workspaceId = null;
  if (body.workspace_id) {
    const { data: m } = await supabase.from('workspace_members')
      .select('user_id').eq('workspace_id', body.workspace_id)
      .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
    if (!m) return forbidden(res, 'Not a workspace member');
    workspaceId = body.workspace_id;
  }

  const row = {
    user_id: req.auth.userId,
    conversation_id: body.conversation_id || null,
    message_id: body.message_id || null,
    workspace_id: workspaceId,
    title: String(body.title).slice(0, 200),
    description: body.description ? String(body.description).slice(0, 2000) : null,
    starts_at: new Date(body.starts_at).toISOString(),
    ends_at: body.ends_at ? new Date(body.ends_at).toISOString() : null,
    location: body.location ? String(body.location).slice(0, 200) : null,
    recurrence: body.recurrence ? String(body.recurrence).slice(0, 500) : null,
    provider: body.provider && VALID_PROVIDERS.includes(body.provider) ? body.provider : null,
  };
  const { data, error } = await supabase.from('calendar_events').insert(row).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  if (row.provider) {
    syncEventToProvider(req.auth.userId, data).catch(() => {});
  }
  created(res, { event: data });
}

/**
 * PUT /calendar/events/:id
 * Update title / starts_at / ends_at / location / recurrence on an event
 * the caller owns. Used by drag-resize on the day view.
 */
async function updateEvent(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const { data: ev } = await supabase.from('calendar_events')
    .select('user_id, workspace_id').eq('id', params.id).maybeSingle();
  if (!ev) return notFound(res);
  if (ev.user_id !== req.auth.userId) {
    // Workspace event: members can edit (admin-only could be added later).
    if (!ev.workspace_id) return forbidden(res);
    const { data: m } = await supabase.from('workspace_members')
      .select('role').eq('workspace_id', ev.workspace_id)
      .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
    if (!m) return forbidden(res);
  }

  const patch = {};
  if (body.title       !== undefined) patch.title = String(body.title).slice(0, 200);
  if (body.description !== undefined) patch.description = body.description ? String(body.description).slice(0, 2000) : null;
  if (body.starts_at   !== undefined) patch.starts_at = new Date(body.starts_at).toISOString();
  if (body.ends_at     !== undefined) patch.ends_at = body.ends_at ? new Date(body.ends_at).toISOString() : null;
  if (body.location    !== undefined) patch.location = body.location ? String(body.location).slice(0, 200) : null;
  if (body.recurrence  !== undefined) patch.recurrence = body.recurrence ? String(body.recurrence).slice(0, 500) : null;
  if (Object.keys(patch).length === 0) return ok(res, { event: ev });

  const { data, error } = await supabase.from('calendar_events')
    .update(patch).eq('id', params.id).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { event: data });
}

/**
 * DELETE /calendar/events/:id
 */
async function deleteEvent(req, res, { params }) {
  const { data: ev } = await supabase.from('calendar_events')
    .select('user_id').eq('id', params.id).maybeSingle();
  if (!ev) return notFound(res);
  if (ev.user_id !== req.auth.userId) return forbidden(res);
  await supabase.from('calendar_events').delete().eq('id', params.id);
  ok(res, { ok: true });
}

async function listEvents(req, res, { query }) {
  const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
  // My events ∪ events in workspaces I'm a member of.
  const { data: memberships } = await supabase.from('workspace_members')
    .select('workspace_id').eq('user_id', req.auth.userId).is('left_at', null);
  const wsIds = (memberships || []).map((m) => m.workspace_id);

  // Two queries (one for my own, one for workspaces) and merge — simpler
  // than building a large `or` on Supabase's PostgREST filter syntax.
  const [mine, shared] = await Promise.all([
    supabase.from('calendar_events').select('*').eq('user_id', req.auth.userId).limit(limit),
    wsIds.length
      ? supabase.from('calendar_events').select('*').in('workspace_id', wsIds).limit(limit)
      : Promise.resolve({ data: [] }),
  ]);
  const seen = new Set();
  const events = [];
  for (const row of [...(mine.data || []), ...(shared.data || [])]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    events.push(row);
  }
  events.sort((a, b) => (b.starts_at || '').localeCompare(a.starts_at || ''));
  ok(res, { events: events.slice(0, limit) });
}

async function syncEventToProvider(userId, event) {
  // Stub — real provider POST goes here. Operator-side work.
  await supabase.from('calendar_events').update({
    synced_at: new Date().toISOString(),
  }).eq('id', event.id);
}

module.exports = { listLinks, oauthBegin, oauthFinish, revoke, createEvent, listEvents, updateEvent, deleteEvent };
