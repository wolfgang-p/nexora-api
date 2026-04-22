'use strict';

const { supabase } = require('../db/supabase');
const { pairingCode } = require('../util/crypto');
const { readJson, badRequest, created, serverError } = require('../util/response');

const PAIRING_TTL_MS = 120 * 1000;

/**
 * POST /pairing/sessions   (no auth — the new device has no identity yet)
 * Body: { new_device_kind, new_device_label?, ephemeral_public_key (b64) }
 * Returns: { id, pairing_code, expires_at }
 */
async function createPairing(req, res) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  const kind = body.new_device_kind;
  const label = body.new_device_label || null;
  const eph = body.ephemeral_public_key;
  if (!['web', 'desktop', 'crm_seat', 'api_bot', 'mobile'].includes(kind)) {
    return badRequest(res, 'Invalid new_device_kind');
  }
  if (!eph || typeof eph !== 'string') return badRequest(res, 'ephemeral_public_key required');

  const ephBuf = Buffer.from(eph, 'base64');
  if (ephBuf.length < 16 || ephBuf.length > 256) {
    return badRequest(res, 'ephemeral_public_key has unreasonable length');
  }

  const code = pairingCode(5);
  const expires = new Date(Date.now() + PAIRING_TTL_MS).toISOString();

  const { data, error } = await supabase.from('pairing_sessions').insert({
    pairing_code: code,
    new_device_kind: kind,
    new_device_label: label,
    ephemeral_public_key: ephBuf,
    expires_at: expires,
  }).select('id, pairing_code, expires_at').single();
  if (error) return serverError(res, 'Could not create pairing session', error);

  created(res, data);
}

module.exports = { createPairing };
