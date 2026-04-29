'use strict';

const { supabase } = require('../db/supabase');
const { ok, created, notFound, badRequest, forbidden, readJson, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { randomBase64Url } = require('../util/crypto');

async function list(req, res) {
  const { data } = await supabase
    .from('workspace_members')
    .select('role, workspace:workspaces!inner(*)')
    .eq('user_id', req.auth.userId).is('left_at', null);
  const workspaces = (data || [])
    .filter((r) => r.workspace && !r.workspace.deleted_at)
    .map((r) => ({ ...r.workspace, my_role: r.role, channels: [], members_count: 0 }));

  if (workspaces.length === 0) return ok(res, { workspaces });

  const wsIds = workspaces.map((w) => w.id);

  // Channels per workspace (conversations kind='channel')
  const { data: chans } = await supabase.from('conversations')
    .select('id, title, avatar_url, workspace_id, updated_at, is_announcement')
    .in('workspace_id', wsIds)
    .eq('kind', 'channel')
    .is('deleted_at', null);

  // Member count per workspace
  const { data: mrows } = await supabase.from('workspace_members')
    .select('workspace_id')
    .in('workspace_id', wsIds)
    .is('left_at', null);
  const countMap = new Map();
  for (const r of mrows || []) countMap.set(r.workspace_id, (countMap.get(r.workspace_id) || 0) + 1);

  const chanByWs = new Map();
  for (const c of chans || []) {
    if (!chanByWs.has(c.workspace_id)) chanByWs.set(c.workspace_id, []);
    chanByWs.get(c.workspace_id).push(c);
  }

  for (const w of workspaces) {
    w.channels = chanByWs.get(w.id) || [];
    w.members_count = countMap.get(w.id) || 0;
  }
  ok(res, { workspaces });
}

async function createChannel(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body?.name) return badRequest(res, 'name required');

  const wsId = params.id;
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', wsId).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me) return forbidden(res);
  if (!['owner', 'admin'].includes(me.role)) return forbidden(res, 'Admin only');

  const name = String(body.name).trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
  if (!name) return badRequest(res, 'invalid name');

  const { data: conv, error } = await supabase.from('conversations').insert({
    kind: 'channel',
    workspace_id: wsId,
    title: name,
    description: body.description || null,
    created_by: req.auth.userId,
    is_announcement: !!body.is_announcement,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  // Add all active workspace members, creator as owner
  const { data: mrows } = await supabase.from('workspace_members')
    .select('user_id').eq('workspace_id', wsId).is('left_at', null);
  const rows = (mrows || []).map((m) => ({
    conversation_id: conv.id,
    user_id: m.user_id,
    role: m.user_id === req.auth.userId ? 'owner' : 'member',
  }));
  if (rows.length) {
    const { error: memErr } = await supabase.from('conversation_members').insert(rows);
    if (memErr) {
      await supabase.from('conversations').delete().eq('id', conv.id);
      return serverError(res, 'Could not add members', memErr);
    }
  }

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: wsId,
    action: 'channel.create', targetType: 'conversation', targetId: conv.id, req });

  created(res, { channel: conv });
}

async function create(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.name) return badRequest(res, 'name required');
  const slug = body.slug
    || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    + '-' + Math.random().toString(36).slice(2, 6);
  const { data: ws, error } = await supabase.from('workspaces').insert({
    name: body.name,
    slug,
    description: body.description || null,
    avatar_url: body.avatar_url || null,
    created_by: req.auth.userId,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  await supabase.from('workspace_members').insert({
    workspace_id: ws.id, user_id: req.auth.userId, role: 'owner',
  });

  // Seed a default #general channel so the workspace isn't empty
  const { data: channel } = await supabase.from('conversations').insert({
    kind: 'channel',
    workspace_id: ws.id,
    title: 'general',
    created_by: req.auth.userId,
  }).select('*').single();
  if (channel) {
    await supabase.from('conversation_members').insert({
      conversation_id: channel.id,
      user_id: req.auth.userId,
      role: 'owner',
    });
  }

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: ws.id,
    action: 'workspace.create', targetType: 'workspace', targetId: ws.id, req });
  created(res, { workspace: { ...ws, my_role: 'owner', channels: channel ? [channel] : [], members_count: 1 } });
}

async function get(req, res, { params }) {
  const { data: ws } = await supabase.from('workspaces').select('*').eq('id', params.id).maybeSingle();
  if (!ws || ws.deleted_at) return notFound(res);
  const { data: me } = await supabase.from('workspace_members')
    .select('role').eq('workspace_id', params.id).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  if (!me) return forbidden(res);
  const { data: members } = await supabase.from('workspace_members')
    .select('user_id, role, joined_at')
    .eq('workspace_id', params.id).is('left_at', null);
  const { data: channels } = await supabase.from('conversations')
    .select('id, title, description, avatar_url, updated_at')
    .eq('workspace_id', params.id).eq('kind', 'channel').is('deleted_at', null);
  ok(res, { workspace: { ...ws, my_role: me.role }, members, channels });
}

async function update(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', params.id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res, 'Admin only');
  const patch = {};
  for (const k of ['name', 'description', 'avatar_url', 'announcement']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (!Object.keys(patch).length) return ok(res, { ok: true });
  const { data, error } = await supabase.from('workspaces').update(patch)
    .eq('id', params.id).select('*').single();
  if (error) return serverError(res, 'Update failed', error);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'workspace.update', targetType: 'workspace', targetId: params.id, metadata: patch, req });
  ok(res, { workspace: data });
}

async function destroy(req, res, { params }) {
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', params.id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (me?.role !== 'owner') return forbidden(res, 'Owner only');
  await supabase.from('workspaces').update({ deleted_at: new Date().toISOString() })
    .eq('id', params.id);
  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: params.id,
    action: 'workspace.delete', targetType: 'workspace', targetId: params.id, req });
  ok(res, { ok: true });
}

async function createInvite(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', params.id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res);
  const code = randomBase64Url(10).toLowerCase();
  const { data, error } = await supabase.from('workspace_invites').insert({
    workspace_id: params.id, code, role: body?.role || 'member',
    created_by: req.auth.userId,
    max_uses: body?.max_uses || null,
    expires_at: body?.expires_at || null,
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);
  created(res, { invite: data });
}

async function joinByCode(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.code) return badRequest(res, 'code required');
  const { data: invite } = await supabase.from('workspace_invites').select('*')
    .eq('code', body.code).is('revoked_at', null).maybeSingle();
  if (!invite) return notFound(res, 'Invite not found');
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return forbidden(res, 'Expired');
  if (invite.max_uses && invite.uses >= invite.max_uses) return forbidden(res, 'Exhausted');

  await supabase.from('workspace_members').upsert({
    workspace_id: invite.workspace_id, user_id: req.auth.userId, role: invite.role,
  }, { onConflict: 'workspace_id,user_id' });
  await supabase.from('workspace_invites').update({ uses: invite.uses + 1 }).eq('id', invite.id);

  // Auto-add the new member to every existing channel of this workspace
  const { data: channels } = await supabase.from('conversations')
    .select('id').eq('workspace_id', invite.workspace_id)
    .eq('kind', 'channel').is('deleted_at', null);
  if (channels?.length) {
    const rows = channels.map((c) => ({
      conversation_id: c.id,
      user_id: req.auth.userId,
      role: 'member',
    }));
    await supabase.from('conversation_members').upsert(rows, {
      onConflict: 'conversation_id,user_id',
    });
  }

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId, workspaceId: invite.workspace_id,
    action: 'workspace.join', targetType: 'workspace', targetId: invite.workspace_id, req });
  ok(res, { workspace_id: invite.workspace_id });
}

/**
 * POST /workspaces/:id/invite-by-contact
 * Body: { email?: string, phone?: string, role?: 'member'|'admin' }
 *
 * Generates a one-shot invite code and dispatches a join link via
 * email or SMS. The recipient does NOT need to be a Koro user — the
 * link drops them into onboarding which finishes with `joinByCode`.
 */
async function inviteByContact(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  const email = (body?.email || '').toString().trim().toLowerCase();
  const phone = (body?.phone || '').toString().trim();
  if (!email && !phone) return badRequest(res, 'email or phone required');

  // Admin gate (same as createInvite)
  const { data: me } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', params.id).eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me || !['owner', 'admin'].includes(me.role)) return forbidden(res);

  const { data: ws } = await supabase.from('workspaces').select('name')
    .eq('id', params.id).maybeSingle();
  const wsName = ws?.name || 'Koro Workspace';

  const code = randomBase64Url(10).toLowerCase();
  const { data: invite, error } = await supabase.from('workspace_invites').insert({
    workspace_id: params.id, code, role: body?.role || 'member',
    created_by: req.auth.userId,
    max_uses: 1,
    expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  }).select('*').single();
  if (error) return serverError(res, 'Create failed', error);

  const base = (process.env.PUBLIC_WEB_URL || 'https://koro.chat').replace(/\/$/, '');
  const link = `${base}/join/${code}`;

  // Resolve inviter display label
  const { data: inviter } = await supabase.from('users')
    .select('display_name, username').eq('id', req.auth.userId).maybeSingle();
  const inviterName = inviter?.display_name || inviter?.username || 'Jemand';

  let dispatched = null;
  try {
    if (email) {
      const { sendEmail } = require('../email');
      await sendEmail({
        to: email,
        subject: `${inviterName} hat dich zu ${wsName} eingeladen`,
        text:
          `Hallo,\n\n${inviterName} hat dich zu „${wsName}" auf Koro eingeladen. ` +
          `Tritt mit diesem Link bei:\n\n${link}\n\nDer Link läuft in 14 Tagen ab.`,
        html:
          `<p>Hallo,</p><p><strong>${inviterName}</strong> hat dich zu „<strong>${wsName}</strong>" auf ` +
          `Koro eingeladen.</p><p><a href="${link}">${link}</a></p><p>Der Link läuft in 14 Tagen ab.</p>`,
      });
      dispatched = 'email';
    } else if (phone) {
      const { sendSms } = require('../sms');
      await sendSms(phone,
        `${inviterName} hat dich zu „${wsName}" auf Koro eingeladen: ${link} (gültig 14 Tage)`);
      dispatched = 'sms';
    }
  } catch (err) {
    // Invite is already created — return it so the inviter at least has the
    // link to share manually.
    return ok(res, { invite, link, dispatched: null, dispatch_error: err?.message || String(err) });
  }

  audit({ userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'workspace.invite_by_contact', targetType: 'workspace', targetId: params.id,
    metadata: { dispatched, code }, req });

  ok(res, { invite, link, dispatched });
}

module.exports = { list, create, get, update, destroy, createInvite, joinByCode, createChannel, inviteByContact };
