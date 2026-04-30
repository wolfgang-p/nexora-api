'use strict';

/**
 * koro.bio — per-user public LinkTree.
 *
 * Authed (token required):
 *   GET    /bio/me                 → my page + links (creates a stub on first call)
 *   PUT    /bio/me                 → update display_name, bio, theme, published
 *   POST   /bio/me/links           → create a link
 *   PUT    /bio/me/links/:id       → update a link (title, url, icon_url, kind, enabled)
 *   DELETE /bio/me/links/:id       → delete a link
 *   POST   /bio/me/links/reorder   → { ids: [uuid, uuid, ...] } sets position
 *
 * Public (no auth):
 *   GET    /bio/public/:username   → page+links if published, plus username/avatar
 *   POST   /bio/public/:username/click  → { link_id } increments click_count
 *
 * Themes are arbitrary JSONB so renderers can iterate independently.
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, notFound, serverError } = require('../util/response');

// Known platform kinds. The renderer maps each to a brand colour + icon.
// 'custom' is the catch-all; the page falls back to fetching the favicon.
const KNOWN_KINDS = new Set([
  'custom', 'website', 'email',
  'instagram', 'facebook', 'x', 'twitter', 'tiktok', 'youtube',
  'linkedin', 'github', 'gitlab', 'twitch', 'spotify', 'soundcloud',
  'pinterest', 'snapchat', 'discord', 'telegram', 'whatsapp', 'signal',
  'threads', 'mastodon', 'bluesky', 'reddit', 'koro',
]);

function sanitizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // Allow mailto:, tel:, and http(s).
  if (/^(mailto:|tel:)/i.test(s)) return s.slice(0, 500);
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.toString().slice(0, 500);
  } catch { return null; }
}

function sanitizeKind(k) {
  if (typeof k !== 'string') return 'custom';
  const v = k.toLowerCase().trim();
  return KNOWN_KINDS.has(v) ? v : 'custom';
}

function trimText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

async function ensurePage(userId) {
  const { data: existing } = await supabase.from('bio_pages')
    .select('*').eq('user_id', userId).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase.from('bio_pages')
    .insert({ user_id: userId }).select('*').single();
  if (error) throw error;
  return data;
}

async function getMine(req, res) {
  try {
    const page = await ensurePage(req.auth.userId);
    const { data: links } = await supabase.from('bio_links')
      .select('*').eq('user_id', req.auth.userId)
      .order('position', { ascending: true });
    ok(res, { page, links: links || [] });
  } catch (err) {
    serverError(res, 'Bio fetch failed', err);
  }
}

async function updateMine(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  await ensurePage(req.auth.userId);
  const patch = { updated_at: new Date().toISOString() };

  if (body.published !== undefined) patch.published = !!body.published;
  if (body.display_name !== undefined) patch.display_name = trimText(body.display_name, 80);
  if (body.bio !== undefined) patch.bio = trimText(body.bio, 280);
  if (body.theme !== undefined) {
    if (typeof body.theme !== 'object' || Array.isArray(body.theme)) {
      return badRequest(res, 'theme must be an object');
    }
    patch.theme = body.theme;
  }

  const { data, error } = await supabase.from('bio_pages')
    .update(patch).eq('user_id', req.auth.userId).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  ok(res, { page: data });
}

async function createLink(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const url = sanitizeUrl(body.url);
  if (!url) return badRequest(res, 'Valid URL required');
  const title = trimText(body.title, 80) || url;
  const kind = sanitizeKind(body.kind);
  const icon_url = body.icon_url ? trimText(body.icon_url, 500) : null;

  await ensurePage(req.auth.userId);

  // Append at the end — find current max position.
  const { data: maxRow } = await supabase.from('bio_links')
    .select('position').eq('user_id', req.auth.userId)
    .order('position', { ascending: false }).limit(1).maybeSingle();
  const position = (maxRow?.position ?? -1) + 1;

  const { data, error } = await supabase.from('bio_links').insert({
    user_id: req.auth.userId,
    kind, title, url, icon_url, position,
  }).select('*').single();
  if (error) return serverError(res, 'Insert failed', error);
  created(res, { link: data });
}

async function updateLink(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const patch = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) {
    const t = trimText(body.title, 80);
    if (!t) return badRequest(res, 'Title required');
    patch.title = t;
  }
  if (body.url !== undefined) {
    const u = sanitizeUrl(body.url);
    if (!u) return badRequest(res, 'Valid URL required');
    patch.url = u;
  }
  if (body.kind !== undefined) patch.kind = sanitizeKind(body.kind);
  if (body.icon_url !== undefined) patch.icon_url = body.icon_url ? trimText(body.icon_url, 500) : null;
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;

  const { data, error } = await supabase.from('bio_links')
    .update(patch).eq('id', params.id).eq('user_id', req.auth.userId)
    .select('*').maybeSingle();
  if (error) return serverError(res, 'Update failed', error);
  if (!data) return notFound(res);
  ok(res, { link: data });
}

async function deleteLink(req, res, { params }) {
  const { error } = await supabase.from('bio_links')
    .delete().eq('id', params.id).eq('user_id', req.auth.userId);
  if (error) return serverError(res, 'Delete failed', error);
  ok(res, { ok: true });
}

async function reorder(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body || !Array.isArray(body.ids)) return badRequest(res, 'ids[] required');

  // Sequence-update each id at its new position. Single-user write so
  // no concurrent-edit race to worry about.
  const ids = body.ids.filter((x) => typeof x === 'string');
  for (let i = 0; i < ids.length; i++) {
    await supabase.from('bio_links')
      .update({ position: i, updated_at: new Date().toISOString() })
      .eq('id', ids[i]).eq('user_id', req.auth.userId);
  }
  ok(res, { ok: true });
}

// ── Public (no auth) ─────────────────────────────────────────────────────

async function viewPublic(req, res, { params }) {
  const username = String(params.username || '').toLowerCase();
  if (!username) return notFound(res);

  const { data: user } = await supabase.from('users')
    .select('id, username, display_name, avatar_url, deleted_at')
    .ilike('username', username).maybeSingle();
  if (!user || user.deleted_at) return notFound(res);

  const { data: page } = await supabase.from('bio_pages')
    .select('display_name, bio, theme, published')
    .eq('user_id', user.id).maybeSingle();
  if (!page || !page.published) return notFound(res);

  const { data: links } = await supabase.from('bio_links')
    .select('id, kind, title, url, icon_url, position')
    .eq('user_id', user.id).eq('enabled', true)
    .order('position', { ascending: true });

  // Best-effort view counter — read-modify-write, fire-and-forget.
  (async () => {
    const { data: row } = await supabase.from('bio_pages')
      .select('view_count').eq('user_id', user.id).maybeSingle();
    if (!row) return;
    await supabase.from('bio_pages')
      .update({ view_count: (row.view_count || 0) + 1 })
      .eq('user_id', user.id);
  })().catch(() => {});

  ok(res, {
    profile: {
      username: user.username,
      display_name: page.display_name || user.display_name,
      avatar_url: user.avatar_url,
      bio: page.bio,
      theme: page.theme || {},
    },
    links: links || [],
  });
}

async function clickPublic(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  const linkId = body?.link_id;
  if (!linkId || typeof linkId !== 'string') return badRequest(res, 'link_id required');

  const username = String(params.username || '').toLowerCase();
  const { data: user } = await supabase.from('users')
    .select('id').ilike('username', username).maybeSingle();
  if (!user) return notFound(res);

  // Best-effort. Use rpc if available; otherwise do a read-modify-write
  // that's good enough for low contention.
  const { data: row } = await supabase.from('bio_links')
    .select('click_count').eq('id', linkId).eq('user_id', user.id).maybeSingle();
  if (!row) return notFound(res);
  await supabase.from('bio_links')
    .update({ click_count: (row.click_count || 0) + 1 })
    .eq('id', linkId).eq('user_id', user.id);
  ok(res, { ok: true });
}

module.exports = {
  getMine, updateMine, createLink, updateLink, deleteLink, reorder,
  viewPublic, clickPublic,
};
