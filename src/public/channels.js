'use strict';

/**
 * Public-channel endpoints.
 *
 *   POST   /conversations/:id/public       (authed: owner/admin) → publishes
 *   PUT    /conversations/:id/public       (authed: owner/admin) → updates title/desc/ro
 *   DELETE /conversations/:id/public       (authed: owner/admin) → unpublishes
 *   GET    /public/channels/:slug          (no auth) → metadata + recent envelopes
 *
 * E2E stays intact: the public viewer gets envelope metadata (sender
 * name as shown publicly, kind, created_at, count of recipients) but
 * NEVER ciphertext. This is enough to render a "this channel exists and
 * recently posted X messages" teaser — you still have to join to read.
 */

const crypto = require('node:crypto');
const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');

async function ensureOwnerOrAdmin(req, convId) {
  const { data: m } = await supabase.from('conversation_members')
    .select('role').eq('conversation_id', convId).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!m) return false;
  return m.role === 'owner' || m.role === 'admin';
}

function newSlug() {
  // URL-safe 16-char slug. ~10^28 space, collisions are effectively impossible.
  return crypto.randomBytes(12).toString('base64url');
}

async function publish(req, res, { params }) {
  const body = await readJson(req).catch(() => ({})) || {};
  if (!(await ensureOwnerOrAdmin(req, params.id))) return forbidden(res);

  const { data: conv } = await supabase.from('conversations')
    .select('id, kind, public_slug').eq('id', params.id).maybeSingle();
  if (!conv) return notFound(res);
  if (conv.kind !== 'channel' && conv.kind !== 'group') {
    return badRequest(res, 'Only channels and groups can be published');
  }

  const slug = conv.public_slug || newSlug();
  const patch = {
    public_slug: slug,
    public_title: body.public_title ? String(body.public_title).slice(0, 120) : null,
    public_description: body.public_description ? String(body.public_description).slice(0, 500) : null,
    public_read_only: body.public_read_only !== false,
    published_at: new Date().toISOString(),
    published_by: req.auth.userId,
  };
  await supabase.from('conversations').update(patch).eq('id', params.id);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'conversation.publish', targetType: 'conversation', targetId: params.id,
    metadata: { slug }, req,
  });

  ok(res, { public_slug: slug, ...patch });
}

async function updatePublic(req, res, { params }) {
  if (!(await ensureOwnerOrAdmin(req, params.id))) return forbidden(res);
  const body = await readJson(req).catch(() => ({})) || {};
  const patch = {};
  if (body.public_title       !== undefined) patch.public_title = body.public_title ? String(body.public_title).slice(0, 120) : null;
  if (body.public_description !== undefined) patch.public_description = body.public_description ? String(body.public_description).slice(0, 500) : null;
  if (body.public_read_only   !== undefined) patch.public_read_only = !!body.public_read_only;
  if (Object.keys(patch).length === 0) return ok(res, {});
  await supabase.from('conversations').update(patch).eq('id', params.id);
  ok(res, { ok: true });
}

async function unpublish(req, res, { params }) {
  if (!(await ensureOwnerOrAdmin(req, params.id))) return forbidden(res);
  await supabase.from('conversations').update({
    public_slug: null, public_title: null, public_description: null,
    published_at: null, published_by: null,
  }).eq('id', params.id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'conversation.unpublish', targetType: 'conversation', targetId: params.id, req,
  });
  ok(res, { ok: true });
}

/** GET /public/channels/:slug — unauthenticated. */
async function viewPublic(req, res, { params }) {
  const { data: conv } = await supabase.from('conversations')
    .select('id, kind, title, created_at, public_title, public_description, public_read_only, published_at')
    .eq('public_slug', params.slug).is('deleted_at', null).maybeSingle();
  if (!conv) return notFound(res, 'Channel not found');

  // Recent activity metadata only — NO ciphertext.
  const { data: recent } = await supabase.from('messages')
    .select('id, kind, created_at, sender_user_id, users:sender_user_id (username, display_name, avatar_url)')
    .eq('conversation_id', conv.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(20);

  const { count: memberCount } = await supabase.from('conversation_members')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conv.id).is('left_at', null);

  ok(res, {
    channel: {
      id: conv.id,
      kind: conv.kind,
      title: conv.public_title || conv.title,
      description: conv.public_description,
      read_only: conv.public_read_only,
      published_at: conv.published_at,
      member_count: memberCount || 0,
      recent_activity: (recent || []).map((m) => ({
        id: m.id, kind: m.kind, created_at: m.created_at,
        sender: m.users
          ? { display_name: m.users.display_name, username: m.users.username, avatar_url: m.users.avatar_url }
          : null,
      })),
    },
  });
}

/**
 * GET /public/channels — list discoverable channels, paged. Returns
 * the same shape `viewPublic` returns minus `recent_activity`. Public
 * (no auth) so unauthenticated marketing surfaces can render it; ranked
 * by member count + recency.
 */
async function listPublic(req, res, { query }) {
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
  const search = (query.q || '').toString().trim().toLowerCase();

  let qb = supabase.from('conversations')
    .select('id, kind, title, public_slug, public_title, public_description, public_read_only, published_at')
    .not('public_slug', 'is', null)
    .is('deleted_at', null)
    .order('published_at', { ascending: false })
    .limit(limit);

  const { data: convs, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);

  let rows = convs || [];
  if (search) {
    rows = rows.filter((c) =>
      (c.public_title || c.title || '').toLowerCase().includes(search) ||
      (c.public_description || '').toLowerCase().includes(search),
    );
  }

  // Member counts in one go.
  const ids = rows.map((c) => c.id);
  const memberCounts = new Map();
  if (ids.length) {
    // Supabase doesn't support GROUP BY in a friendly way through PostgREST;
    // do N small head-counts. Fine for ~50 results.
    await Promise.all(ids.map(async (id) => {
      const { count } = await supabase.from('conversation_members')
        .select('*', { count: 'exact', head: true })
        .eq('conversation_id', id).is('left_at', null);
      memberCounts.set(id, count || 0);
    }));
  }

  ok(res, {
    channels: rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      slug: c.public_slug,
      title: c.public_title || c.title,
      description: c.public_description,
      read_only: !!c.public_read_only,
      member_count: memberCounts.get(c.id) || 0,
      published_at: c.published_at,
    })),
  });
}

/**
 * POST /public/channels/:slug/join (authed)
 * Adds the caller as a regular member of the channel. No-op if already
 * a member. Read-only channels still allow joining — only posting is
 * restricted (existing only_admins_send / public_read_only gate).
 */
async function joinPublic(req, res, { params }) {
  const { data: conv } = await supabase.from('conversations')
    .select('id, kind').eq('public_slug', params.slug)
    .is('deleted_at', null).maybeSingle();
  if (!conv) return notFound(res, 'Channel not found');

  const { data: existing } = await supabase.from('conversation_members')
    .select('user_id, left_at').eq('conversation_id', conv.id)
    .eq('user_id', req.auth.userId).maybeSingle();

  if (existing && !existing.left_at) {
    return ok(res, { conversation_id: conv.id, already_member: true });
  }
  if (existing && existing.left_at) {
    // Re-join: clear the left_at flag.
    await supabase.from('conversation_members').update({ left_at: null })
      .eq('conversation_id', conv.id).eq('user_id', req.auth.userId);
  } else {
    await supabase.from('conversation_members').insert({
      conversation_id: conv.id, user_id: req.auth.userId, role: 'member',
    });
  }

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'conversation.join_public', targetType: 'conversation', targetId: conv.id, req,
  });

  ok(res, { conversation_id: conv.id, already_member: false });
}

module.exports = { publish, updatePublic, unpublish, viewPublic, listPublic, joinPublic };
