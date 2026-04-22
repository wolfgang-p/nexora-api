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

module.exports = { UPLOAD_ROOT, plan, resolveKey, ensureDir, removeKey, pickExtension };
