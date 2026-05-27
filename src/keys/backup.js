'use strict';

/**
 * Zero-knowledge E2E key backup.
 *
 * The client derives a symmetric key from a user-chosen recovery passphrase
 * (PBKDF2) and uses it to wrap its device secret key (NaCl secretbox). Only
 * the resulting opaque blob (salt + nonce + ciphertext) is stored here — the
 * server never sees the passphrase or the plaintext key, so it cannot decrypt
 * message history. A re-registered / new device can fetch this blob and, with
 * the passphrase, recover the key to decrypt historical messages.
 *
 *   GET    /keys/backup   → { salt, nonce, wrapped_secret, kdf, updated_at }
 *   PUT    /keys/backup   { salt, nonce, wrapped_secret, kdf? }
 *   DELETE /keys/backup
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, notFound, serverError } = require('../util/response');

async function getBackup(req, res) {
  const { data, error } = await supabase
    .from('key_backups')
    .select('salt, nonce, wrapped_secret, kdf, updated_at')
    .eq('user_id', req.auth.userId)
    .maybeSingle();
  if (error) return serverError(res, 'Backup lookup failed', error);
  if (!data) return notFound(res, 'No backup');
  ok(res, data);
}

async function putBackup(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body?.salt || !body?.nonce || !body?.wrapped_secret) {
    return badRequest(res, 'salt, nonce, wrapped_secret required');
  }
  const row = {
    user_id: req.auth.userId,
    salt: String(body.salt).slice(0, 256),
    nonce: String(body.nonce).slice(0, 256),
    wrapped_secret: String(body.wrapped_secret).slice(0, 8192),
    kdf: String(body.kdf || 'pbkdf2-sha256-210k').slice(0, 64),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('key_backups').upsert(row, { onConflict: 'user_id' });
  if (error) return serverError(res, 'Backup save failed', error);
  ok(res, { ok: true });
}

async function deleteBackup(req, res) {
  const { error } = await supabase.from('key_backups').delete().eq('user_id', req.auth.userId);
  if (error) return serverError(res, 'Backup delete failed', error);
  ok(res, { ok: true });
}

module.exports = { getBackup, putBackup, deleteBackup };
