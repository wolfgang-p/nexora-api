'use strict';

/**
 * Workspace-wide search — one query, fanned out across every kind of
 * content in a workspace: channels, drive files, tasks, calendar events
 * and wiki pages. Each bucket is capped so the response stays small.
 *
 *   GET /workspaces/:id/search?q=…  →
 *     { channels:[], files:[], tasks:[], events:[], pages:[] }
 */

const { supabase } = require('../db/supabase');
const { ok, badRequest, forbidden } = require('../util/response');

async function requireMember(req, workspaceId) {
  const { data } = await supabase.from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', req.auth.userId)
    .is('left_at', null).maybeSingle();
  return data || null;
}

const PER = 10;

async function search(req, res, { params, query }) {
  const me = await requireMember(req, params.id);
  if (!me) return forbidden(res);

  const q = String(query.q || '').trim();
  if (q.length < 2) return badRequest(res, 'q must be at least 2 characters');
  const like = `%${q}%`;

  const [channels, files, tasks, events, pages] = await Promise.all([
    supabase.from('conversations')
      .select('id, title, description, avatar_url, updated_at')
      .eq('workspace_id', params.id).eq('kind', 'channel').is('deleted_at', null)
      .ilike('title', like).limit(PER),

    supabase.from('workspace_files')
      .select('id, name, is_folder, parent_folder_id, media_object_id, tags, created_at, media:media_object_id (mime_type, size_bytes)')
      .eq('workspace_id', params.id).is('deleted_at', null)
      .or(`name.ilike.${like},description.ilike.${like}`).limit(PER),

    supabase.from('tasks')
      .select('id, title, status, priority, due_at, assignee_user_id')
      .eq('workspace_id', params.id).is('deleted_at', null)
      .or(`title.ilike.${like},description.ilike.${like}`).limit(PER),

    supabase.from('calendar_events')
      .select('id, title, starts_at, ends_at, location')
      .eq('workspace_id', params.id)
      .ilike('title', like).limit(PER),

    supabase.from('workspace_pages')
      .select('id, title, pinned_at, updated_at')
      .eq('workspace_id', params.id).is('deleted_at', null)
      .or(`title.ilike.${like},body.ilike.${like}`).limit(PER),
  ]);

  ok(res, {
    channels: channels.data || [],
    files: files.data || [],
    tasks: tasks.data || [],
    events: events.data || [],
    pages: pages.data || [],
  });
}

module.exports = { search };
