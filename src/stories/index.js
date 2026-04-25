'use strict';

/**
 * Stories / Status — 24h-ephemeral posts.
 *
 *   POST   /stories                       — create a story
 *   GET    /stories/feed                  — list active stories visible to me
 *   GET    /stories/:id                   — details + my view flag
 *   DELETE /stories/:id                   — delete (own stories only)
 *   POST   /stories/:id/view              — mark viewed
 *   POST   /stories/:id/reactions         — react with an emoji
 *   DELETE /stories/:id/reactions/:emoji  — remove my reaction
 *
 * E2E: the creator's client builds per-device ciphertexts (same fanout
 * model as messages) and POSTs them along with the meta. The server
 * stores `story_recipients` rows and never sees the plaintext.
 *
 * Expiration: stories carry `expires_at` (default 24h). The retention
 * sweeper already in scheduler.js could soft-delete expired rows; for
 * now, listing endpoints filter out expired/deleted rows so stale data
 * never leaks even if the sweeper isn't configured for stories yet.
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { broadcastToDevices } = require('../ws/dispatch');

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 72; // a hard ceiling so nobody publishes a "story" forever

/** POST /stories */
async function create(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const kind = body.kind;
  if (!['text', 'image', 'video'].includes(kind)) return badRequest(res, 'invalid kind');

  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return badRequest(res, 'recipients[] required');
  }
  for (const r of body.recipients) {
    if (!r?.device_id || !r?.ciphertext || !r?.nonce) {
      return badRequest(res, 'each recipient needs device_id, ciphertext, nonce');
    }
  }
  if (body.recipients.length > 500) return badRequest(res, 'too many recipients');

  const hours = Math.max(1, Math.min(MAX_TTL_HOURS, Number(body.ttl_hours) || DEFAULT_TTL_HOURS));
  const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();

  const { data: story, error } = await supabase.from('stories').insert({
    creator_user_id: req.auth.userId,
    workspace_id: body.workspace_id || null,
    kind,
    media_object_id: body.media_object_id || null,
    width_hint: body.width_hint || null,
    height_hint: body.height_hint || null,
    duration_ms: body.duration_ms || null,
    expires_at: expiresAt,
  }).select('*').single();
  if (error) return serverError(res, 'Could not create story', error);

  const rows = body.recipients.map((r) => ({
    story_id: story.id,
    recipient_device_id: r.device_id,
    ciphertext: r.ciphertext,
    nonce: r.nonce,
  }));
  const { error: rErr } = await supabase.from('story_recipients').insert(rows);
  if (rErr) {
    await supabase.from('stories').delete().eq('id', story.id);
    return serverError(res, 'Could not seal story recipients', rErr);
  }

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'story.create', targetType: 'story', targetId: story.id,
    metadata: { kind, recipient_count: rows.length, expires_at: expiresAt },
    req,
  });

  // WS fan-out so live clients drop a new ring around the creator's avatar.
  const deviceIds = body.recipients.map((r) => r.device_id);
  broadcastToDevices(deviceIds, () => ({ type: 'story.new', story_id: story.id, creator_user_id: req.auth.userId }));

  created(res, { story: { id: story.id, expires_at: expiresAt } });
}

/**
 * GET /stories/feed?include_expired=0
 * Groups active stories by creator_user_id so the UI can render one
 * avatar-ring per friend.
 */
async function feed(req, res, { query }) {
  const includeExpired = query.include_expired === '1';
  const since = includeExpired ? null : new Date().toISOString();

  // For each story I have a device recipient row on, pull it.
  const { data: myCopies } = await supabase.from('story_recipients')
    .select('story_id, ciphertext, nonce')
    .eq('recipient_device_id', req.auth.deviceId);
  const idMap = new Map((myCopies || []).map((r) => [r.story_id, r]));
  if (idMap.size === 0) return ok(res, { feed: [] });

  let qb = supabase.from('stories')
    .select('id, creator_user_id, workspace_id, kind, media_object_id, width_hint, height_hint, duration_ms, expires_at, created_at, deleted_at, users:creator_user_id (id, username, display_name, avatar_url)')
    .in('id', Array.from(idMap.keys()))
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (since) qb = qb.gt('expires_at', since);

  const { data: stories, error } = await qb;
  if (error) return serverError(res, 'Query failed', error);

  // Pull my view/reaction state for the returned stories so the UI can
  // render the "seen" dot + my reactions without another round-trip.
  const sIds = (stories || []).map((s) => s.id);
  const [views, reactions] = await Promise.all([
    sIds.length
      ? supabase.from('story_views').select('story_id').eq('user_id', req.auth.userId).in('story_id', sIds)
      : { data: [] },
    sIds.length
      ? supabase.from('story_reactions').select('story_id, emoji').eq('user_id', req.auth.userId).in('story_id', sIds)
      : { data: [] },
  ]);
  const viewedSet = new Set((views.data || []).map((v) => v.story_id));
  const myReactions = new Map();
  for (const r of (reactions.data || [])) {
    const arr = myReactions.get(r.story_id) || [];
    arr.push(r.emoji);
    myReactions.set(r.story_id, arr);
  }

  const feedRows = (stories || []).map((s) => ({
    id: s.id,
    creator: s.users,
    workspace_id: s.workspace_id,
    kind: s.kind,
    media_object_id: s.media_object_id,
    width_hint: s.width_hint,
    height_hint: s.height_hint,
    duration_ms: s.duration_ms,
    expires_at: s.expires_at,
    created_at: s.created_at,
    ciphertext: idMap.get(s.id)?.ciphertext || null,
    nonce: idMap.get(s.id)?.nonce || null,
    viewed: viewedSet.has(s.id),
    my_reactions: myReactions.get(s.id) || [],
  }));

  ok(res, { feed: feedRows });
}

async function getOne(req, res, { params }) {
  const { data: story, error } = await supabase.from('stories')
    .select('*, users:creator_user_id (id, username, display_name, avatar_url)')
    .eq('id', params.id).maybeSingle();
  if (error) return serverError(res, 'Query failed', error);
  if (!story) return notFound(res, 'Story not found');
  if (story.deleted_at) return notFound(res, 'Story deleted');

  // Must have a recipient row OR be the creator.
  if (story.creator_user_id !== req.auth.userId) {
    const { data: copy } = await supabase.from('story_recipients')
      .select('ciphertext, nonce').eq('story_id', story.id)
      .eq('recipient_device_id', req.auth.deviceId).maybeSingle();
    if (!copy) return forbidden(res);
    story.ciphertext = copy.ciphertext;
    story.nonce = copy.nonce;
  }

  // Hydrate aggregate view + reaction counts (only visible to the creator,
  // or to any viewer as aggregate numbers — never as identities).
  const [{ count: viewCount }, { data: reactionRows }] = await Promise.all([
    supabase.from('story_views').select('*', { count: 'exact', head: true }).eq('story_id', story.id),
    supabase.from('story_reactions').select('emoji').eq('story_id', story.id),
  ]);
  const reactionCounts = {};
  for (const r of (reactionRows || [])) reactionCounts[r.emoji] = (reactionCounts[r.emoji] || 0) + 1;

  ok(res, {
    story: {
      ...story,
      view_count: viewCount || 0,
      reaction_counts: reactionCounts,
    },
  });
}

async function markViewed(req, res, { params }) {
  // Membership check implicit: must have a recipient row to view.
  const { data: copy } = await supabase.from('story_recipients')
    .select('story_id').eq('story_id', params.id)
    .eq('recipient_device_id', req.auth.deviceId).maybeSingle();
  if (!copy) {
    // Allow the creator to self-mark (no-op) so the UI doesn't need a
    // branch for "this is my own story".
    const { data: s } = await supabase.from('stories').select('creator_user_id').eq('id', params.id).maybeSingle();
    if (!s || s.creator_user_id !== req.auth.userId) return forbidden(res);
  }
  await supabase.from('story_views').upsert({
    story_id: params.id, user_id: req.auth.userId,
  }, { onConflict: 'story_id,user_id', ignoreDuplicates: true });
  ok(res, { ok: true });
}

async function react(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.emoji) return badRequest(res, 'emoji required');
  const emoji = String(body.emoji).slice(0, 16);
  await supabase.from('story_reactions').upsert({
    story_id: params.id, user_id: req.auth.userId, emoji,
  }, { onConflict: 'story_id,user_id,emoji', ignoreDuplicates: true });
  ok(res, { ok: true });
}

async function unreact(req, res, { params }) {
  await supabase.from('story_reactions').delete()
    .eq('story_id', params.id).eq('user_id', req.auth.userId).eq('emoji', params.emoji);
  ok(res, { ok: true });
}

async function destroy(req, res, { params }) {
  const { data: s } = await supabase.from('stories').select('creator_user_id').eq('id', params.id).maybeSingle();
  if (!s) return notFound(res);
  if (s.creator_user_id !== req.auth.userId && !req.auth.user?.is_admin) return forbidden(res);
  await supabase.from('stories').update({ deleted_at: new Date().toISOString() }).eq('id', params.id);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'story.delete', targetType: 'story', targetId: params.id, req,
  });
  ok(res, { ok: true });
}

module.exports = { create, feed, getOne, markViewed, react, unreact, destroy };
