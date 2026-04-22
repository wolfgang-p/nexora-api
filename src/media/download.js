'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { supabase } = require('../db/supabase');
const { notFound, forbidden, serverError } = require('../util/response');
const { resolveKey } = require('./fs');

/**
 * GET /media/:id
 *
 * Serves the raw bytes on disk.
 *   - If the media has conversation_id: the caller's user must be a member.
 *   - If conversation_id is NULL (e.g. avatars): any authenticated user may fetch.
 *
 * For conversation-scoped (encrypted) media, the client needs to
 * additionally call GET /media/:id/key to get its per-device wrapped key.
 */
async function download(req, res, { params }) {
  const { data: media } = await supabase
    .from('media_objects')
    .select('id, conversation_id, storage_key, mime_type, size_bytes, deleted_at')
    .eq('id', params.id)
    .maybeSingle();
  if (!media || media.deleted_at) return notFound(res, 'Media not found');

  if (media.conversation_id) {
    const { data: me } = await supabase
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', media.conversation_id)
      .eq('user_id', req.auth.userId)
      .is('left_at', null)
      .maybeSingle();
    if (!me) return forbidden(res, 'Not a conversation member');
  }

  let abs;
  try { abs = resolveKey(media.storage_key); }
  catch { return notFound(res, 'File missing'); }

  let stat;
  try { stat = await fsp.stat(abs); }
  catch { return notFound(res, 'File missing'); }

  res.writeHead(200, {
    'Content-Type': media.mime_type,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  try {
    await pipeline(fs.createReadStream(abs), res);
  } catch (err) {
    // Client disconnected mid-stream; not an error worth reporting
    if (!res.writableEnded) {
      try { res.end(); } catch { /* ignore */ }
    }
  }
}

module.exports = { download };
