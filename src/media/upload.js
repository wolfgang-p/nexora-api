'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { supabase } = require('../db/supabase');
const { readJson, ok, created, badRequest, notFound, forbidden, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { plan, ensureDir, resolveKey, removeKey } = require('./fs');
const config = require('../config');

/**
 * POST /media/upload
 *
 * Raw-body upload. Client sends the file bytes as the request body and sets:
 *   Content-Type: image/jpeg         (required)
 *   Content-Length: <bytes>          (required, enforces size limit)
 *   X-File-Name: optional-name.jpg   (optional; used for extension picking)
 *   X-Conversation-Id: <uuid>        (optional; if set, media is scoped to that conv)
 *
 * Response: { media: { id, url, mime_type, size_bytes, sha256 } }
 */
async function upload(req, res) {
  const mime = (req.headers['content-type'] || '').split(';')[0].trim();
  const size = Number(req.headers['content-length'] || 0);
  const fileName = req.headers['x-file-name'] || null;
  const conversationId = req.headers['x-conversation-id'] || null;

  if (!mime) return badRequest(res, 'Content-Type required');
  if (!size) return badRequest(res, 'Content-Length required');
  if (size <= 0) return badRequest(res, 'Empty body');
  if (size > config.media.maxSizeBytes) {
    return badRequest(res, `File exceeds ${config.media.maxSizeBytes} bytes`);
  }

  // Optional: confirm membership if conversation-scoped
  if (conversationId) {
    const { data: me } = await supabase
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .eq('user_id', req.auth.userId)
      .is('left_at', null)
      .maybeSingle();
    if (!me) return forbidden(res, 'Not a conversation member');
  }

  const p = plan(mime, fileName);
  await ensureDir(p.dir);

  const hash = crypto.createHash('sha256');
  let written = 0;

  // Stream body → disk, hashing + enforcing max size
  const writeStream = fs.createWriteStream(p.absPath);
  req.on('data', (chunk) => hash.update(chunk));
  try {
    await pipeline(
      // Custom through that counts bytes (Content-Length may lie)
      async function* (source) {
        for await (const chunk of source) {
          written += chunk.length;
          if (written > config.media.maxSizeBytes) {
            throw Object.assign(new Error('Body exceeds size limit'), { statusCode: 413 });
          }
          yield chunk;
        }
      }(req),
      writeStream,
    );
  } catch (err) {
    // Clean up partial write
    await fsp.unlink(p.absPath).catch(() => {});
    if (err.statusCode === 413) return badRequest(res, err.message);
    return serverError(res, 'Upload failed', err);
  }

  const sha256 = hash.digest('hex');

  const { data: media, error } = await supabase.from('media_objects').insert({
    uploader_user_id: req.auth.userId,
    uploader_device_id: req.auth.deviceId,
    conversation_id: conversationId,
    storage_key: p.storageKey,
    mime_type: mime,
    size_bytes: written,
    sha256,
  }).select('*').single();

  if (error) {
    // Best-effort unlink — we persisted the bytes but failed to record them
    await fsp.unlink(p.absPath).catch(() => {});
    return serverError(res, 'Could not register media', error);
  }

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'media.upload', targetType: 'media', targetId: media.id,
    metadata: { mime, size: written, conversation_id: conversationId }, req,
  });

  created(res, {
    media: {
      id: media.id,
      url: publicUrl(req, media.id),
      mime_type: media.mime_type,
      size_bytes: media.size_bytes,
      sha256: media.sha256,
      conversation_id: media.conversation_id,
      created_at: media.created_at,
    },
  });
}

/**
 * POST /media/:id/recipients
 * Body: { recipients: [{ device_id, wrapped_key (b64), nonce (b64) }] }
 *
 * Used only for encrypted (conversation-scoped) media. Stores the per-device
 * wrapped content key so each recipient device can decrypt the bytes it
 * downloads from /media/:id.
 */
async function postRecipients(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!Array.isArray(body?.recipients)) return badRequest(res, 'recipients[] required');

  const { data: media } = await supabase.from('media_objects').select('*')
    .eq('id', params.id).maybeSingle();
  if (!media) return notFound(res, 'Media not found');
  if (media.uploader_user_id !== req.auth.userId) return forbidden(res, 'Not your media');

  const rows = body.recipients.map((r) => ({
    media_object_id: params.id,
    recipient_device_id: r.device_id,
    wrapped_key: Buffer.from(r.wrapped_key, 'base64'),
    nonce: Buffer.from(r.nonce, 'base64'),
  }));
  const { error } = await supabase.from('media_recipients').insert(rows);
  if (error) return serverError(res, 'Could not store recipients', error);

  ok(res, { ok: true });
}

/**
 * GET /media/:id/key
 * Returns the wrapped content key for *this* device, for encrypted media.
 */
async function getMyKey(req, res, { params }) {
  const { data: rcp } = await supabase
    .from('media_recipients')
    .select('wrapped_key, nonce')
    .eq('media_object_id', params.id)
    .eq('recipient_device_id', req.auth.deviceId)
    .maybeSingle();
  if (!rcp) return notFound(res, 'No wrapped key for this device');
  ok(res, {
    wrapped_key: Buffer.from(rcp.wrapped_key).toString('base64'),
    nonce: Buffer.from(rcp.nonce).toString('base64'),
  });
}

function publicUrl(req, mediaId) {
  // Build an absolute URL using the request's host header so it works behind
  // reverse proxies that set X-Forwarded-Host.
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${host}/media/${mediaId}`;
}

module.exports = { upload, postRecipients, getMyKey, publicUrl };

// Exported for download.js
module.exports.resolveKey = resolveKey;
module.exports.removeKey = removeKey;
