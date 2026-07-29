'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

/** Return relative storage key like "2026/04/<uuid>.<ext>" and the absolute path. */
function plan(mimeType, originalName) {
  const ext = pickExtension(mimeType, originalName);
  const uuid = crypto.randomUUID();
  const d = new Date();
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const storageKey = path.posix.join(yyyy, mm, `${uuid}${ext ? '.' + ext : ''}`);
  const absPath = path.join(UPLOAD_ROOT, yyyy, mm, `${uuid}${ext ? '.' + ext : ''}`);
  return { storageKey, absPath, dir: path.dirname(absPath) };
}

/** Resolve a storage_key back to an absolute path, rejecting path traversal. */
function resolveKey(storageKey) {
  // Normalize, refuse anything that escapes UPLOAD_ROOT
  const abs = path.resolve(UPLOAD_ROOT, storageKey);
  if (!abs.startsWith(UPLOAD_ROOT + path.sep) && abs !== UPLOAD_ROOT) {
    throw new Error('Path traversal blocked');
  }
  return abs;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function removeKey(storageKey) {
  try { await fsp.unlink(resolveKey(storageKey)); } catch { /* ignore */ }
}

/**
 * Storage key + absolute path for a per-speaker meeting recording. One stable
 * file per (meeting, device) so chunks can be appended across the whole meeting:
 *   meetings/<meetingId>/<deviceId>.webm
 * meetingId/deviceId come from our own DB / signaling ids, but we still sanitize
 * to a safe charset so a crafted device id can't escape the meetings dir.
 */
function planRecording(meetingId, deviceId, ext = 'webm') {
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const mId = safe(meetingId);
  const dId = safe(deviceId);
  const storageKey = path.posix.join('meetings', mId, `${dId}.${ext}`);
  const absPath = path.join(UPLOAD_ROOT, 'meetings', mId, `${dId}.${ext}`);
  return { storageKey, absPath, dir: path.dirname(absPath) };
}

/**
 * Append a chunk of bytes to a recording file, creating it (and its dir) on the
 * first chunk. Returns the new total byte size of the file. Serialized per path
 * via a tiny in-process lock so out-of-order concurrent appends to the SAME file
 * can't interleave (chunks for one speaker come from one sticky-session browser,
 * but a reconnect could briefly overlap).
 */
const _appendLocks = new Map(); // absPath -> Promise chain tail
async function appendChunk(absPath, buffer) {
  const prev = _appendLocks.get(absPath) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.appendFile(absPath, buffer);
    const st = await fsp.stat(absPath);
    return st.size;
  });
  _appendLocks.set(absPath, run);
  try {
    return await run;
  } finally {
    if (_appendLocks.get(absPath) === run) _appendLocks.delete(absPath);
  }
}

function pickExtension(mimeType, originalName) {
  if (originalName && /\.[A-Za-z0-9]{1,6}$/.test(originalName)) {
    const m = originalName.match(/\.([A-Za-z0-9]{1,6})$/);
    return m[1].toLowerCase();
  }
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
    'audio/m4a': 'm4a', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
    'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'application/pdf': 'pdf',
    'application/octet-stream': 'bin',
  };
  return map[mimeType] || 'bin';
}

module.exports = {
  UPLOAD_ROOT, plan, resolveKey, ensureDir, removeKey, pickExtension,
  planRecording, appendChunk,
};
