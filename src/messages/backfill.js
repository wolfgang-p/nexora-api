'use strict';

const { supabase } = require('../db/supabase');
const { readJson, badRequest, ok, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { check, send429 } = require('../middleware/rateLimit');

/**
 * POST /messages/:id/recipients   (authed)
 *
 * Add ADDITIONAL sealed copies of an EXISTING message for the caller's OWN
 * other devices. This backs "history sync" (WhatsApp-style): a device that can
 * already decrypt a message (the phone) re-seals its plaintext to another of
 * the user's devices — e.g. a newly linked web/OAuth device that adopted the
 * stable identity key — and uploads the copy here. The read path (list.js) then
 * serves that copy to the target device, which opens it with the key it holds.
 *
 * SECURITY / SCOPE:
 *  - The server never sees plaintext; it only stores new ciphertext.
 *  - Self-scoped: every target device_id must be a NON-REVOKED device owned by
 *    the CALLER. You can only add copies for your own devices, never inject
 *    copies for peers. This makes the endpoint safe to expose broadly.
 *  - Idempotent: upsert on the (message_id, recipient_device_id) primary key,
 *    so re-running the backfill never duplicates or errors.
 *
 * Body: { recipients: [{ device_id, ciphertext: b64, nonce: b64 }, ...] }
 */
async function addRecipients(req, res, { params }) {
  const body = await readJson(req).catch(() => null);
  if (!body) return badRequest(res, 'Invalid JSON');

  // Backfill can touch a lot of messages; keep it under its own rate limit,
  // separate from send:, so a sync sweep can't exhaust the send budget.
  const lim = check([
    { key: `backfill:${req.auth.userId}`, max: 600, windowMs: 60_000 },
  ]);
  if (!lim.ok) return send429(res, lim);

  const messageId = params.id;
  const { recipients } = body;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return badRequest(res, 'recipients[] required');
  }
  if (recipients.length > 50) return badRequest(res, 'Too many recipients in one call');

  // The message must exist and the caller must be an active member of its
  // conversation (so a stranger can't add copies to arbitrary messages).
  const { data: msg } = await supabase
    .from('messages')
    .select('id, conversation_id, deleted_at')
    .eq('id', messageId).maybeSingle();
  if (!msg || msg.deleted_at) return notFound(res, 'Message not found');

  const { data: me } = await supabase
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', msg.conversation_id)
    .eq('user_id', req.auth.userId)
    .is('left_at', null)
    .maybeSingle();
  if (!me) return forbidden(res, 'Not a conversation member');

  // Self-scoped: target devices must be the caller's OWN non-revoked devices.
  const targetIds = [...new Set(recipients.map((r) => r?.device_id).filter(Boolean))];
  const { data: ownDevices } = await supabase
    .from('devices')
    .select('id')
    .eq('user_id', req.auth.userId)
    .is('revoked_at', null)
    .in('id', targetIds);
  const ownSet = new Set((ownDevices || []).map((d) => d.id));

  const rows = [];
  for (const r of recipients) {
    if (!r?.device_id || !r?.ciphertext || !r?.nonce) {
      return badRequest(res, 'recipient must have device_id, ciphertext, nonce');
    }
    if (!ownSet.has(r.device_id)) {
      return forbidden(res, `Device ${r.device_id} is not one of your active devices`);
    }
    rows.push({
      message_id: messageId,
      recipient_device_id: r.device_id,
      ciphertext: r.ciphertext,
      nonce: r.nonce,
    });
  }

  // Idempotent upsert on the composite PK. ignoreDuplicates=false so a re-run
  // refreshes the ciphertext (harmless — same plaintext), never errors.
  const { error } = await supabase
    .from('message_recipients')
    .upsert(rows, { onConflict: 'message_id,recipient_device_id', ignoreDuplicates: false });
  if (error) return serverError(res, 'Could not store recipient copies', error);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'message.backfill_recipients', targetType: 'message', targetId: messageId,
    metadata: { count: rows.length }, req,
  });

  ok(res, { ok: true, added: rows.length });
}

module.exports = { addRecipients };
