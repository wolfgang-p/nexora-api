'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { supabase } = require('../db/supabase');
const { notFound, forbidden, unauthorized } = require('../util/response');
const { resolveKey } = require('./fs');
const { authenticate } = require('../auth/middleware');

/**
 * GET /media/:id  (auth optional at router level)
 *
 * Serves the raw bytes on disk.
 *   - If the media has conversation_id: the caller must authenticate AND be
 *     a member of that conversation.
 *   - If conversation_id is NULL (avatars, public assets): anyone can fetch
 *     so <img src> tags work without custom headers. The file itself is just
 *     the avatar bitmap, not E2E-encrypted content.
 */
async function download(req, res, { params }) {
  const { data: media } = await supabase
    .from('media_objects')
    .select('id, conversation_id, storage_key, mime_type, size_bytes, deleted_at')
    .eq('id', params.id)
    .maybeSingle();
  if (!media || media.deleted_at) return notFound(res, 'Media not found');

  if (media.conversation_id) {
    // Conversation-scoped media: auth required + membership check.
    const authed = await authenticate(req, res);
    if (!authed) return; // authenticate already wrote 401
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
    'Cache-Control': media.conversation_id
      ? 'private, max-age=31536000, immutable'
      : 'public, max-age=31536000, immutable',
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
