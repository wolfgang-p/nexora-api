'use strict';

const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, serverError } = require('../util/response');
const { randomBase64Url, sha256 } = require('../util/crypto');
const config = require('../config');

/**
 * POST /media/upload-url   — request a short-lived signed URL for a direct
 * upload to Supabase Storage. Client uploads *already-encrypted* bytes.
 * Body: { conversation_id?, size_bytes, mime_type, sha256, width?, height?, duration_ms? }
 * Returns: { media_object_id, upload_url, storage_key }
 */
async function getUploadUrl(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');
  if (!body.size_bytes || !body.mime_type || !body.sha256) {
    return badRequest(res, 'size_bytes, mime_type, sha256 required');
  }
  if (body.size_bytes > config.media.maxSizeBytes) {
    return badRequest(res, `File exceeds ${config.media.maxSizeBytes} bytes`);
  }

  const storageKey = `${req.auth.userId}/${randomBase64Url(16)}`;
  const { data: media, error } = await supabase.from('media_objects').insert({
    uploader_user_id: req.auth.userId,
    uploader_device_id: req.auth.deviceId,
    conversation_id: body.conversation_id || null,
    storage_key: storageKey,
    mime_type: body.mime_type,
    size_bytes: body.size_bytes,
    width: body.width || null,
    height: body.height || null,
    duration_ms: body.duration_ms || null,
    sha256: body.sha256,
  }).select('*').single();
  if (error) return serverError(res, 'Could not reserve media', error);

  const { data: signed, error: sErr } = await supabase.storage
    .from(config.media.bucket)
    .createSignedUploadUrl(storageKey);
  if (sErr) return serverError(res, 'Could not mint upload URL', sErr);

  ok(res, {
    media_object_id: media.id,
    storage_key: storageKey,
    upload_url: signed.signedUrl,
    token: signed.token,
  });
}

/**
 * POST /media/:id/recipients  — after uploading, send per-device wrapped keys.
 * Body: { recipients: [{ device_id, wrapped_key: b64, nonce: b64 }, ...] }
 */
async function postRecipients(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!Array.isArray(body?.recipients)) return badRequest(res, 'recipients[] required');

  const { data: media } = await supabase.from('media_objects').select('*')
    .eq('id', params.id).maybeSingle();
  if (!media || media.uploader_user_id !== req.auth.userId) {
    return badRequest(res, 'Media not found or not yours');
  }

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
 * GET /media/:id/download-url  — signed read URL for this device.
 */
async function getDownloadUrl(req, res, { params }) {
  const { data: media } = await supabase.from('media_objects').select('*')
    .eq('id', params.id).maybeSingle();
  if (!media) return badRequest(res, 'Not found');

  // Is this device a recipient?
  const { data: rcp } = await supabase.from('media_recipients')
    .select('wrapped_key, nonce')
    .eq('media_object_id', params.id)
    .eq('recipient_device_id', req.auth.deviceId).maybeSingle();
  if (!rcp) return badRequest(res, 'No key for this device');

  const { data: signed, error } = await supabase.storage
    .from(config.media.bucket)
    .createSignedUrl(media.storage_key, 60 * 5);
  if (error) return serverError(res, 'Could not sign', error);

  ok(res, {
    download_url: signed.signedUrl,
    wrapped_key: Buffer.from(rcp.wrapped_key).toString('base64'),
    nonce: Buffer.from(rcp.nonce).toString('base64'),
    mime_type: media.mime_type,
    size_bytes: media.size_bytes,
  });
}

module.exports = { getUploadUrl, postRecipients, getDownloadUrl };
