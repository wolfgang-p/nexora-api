'use strict';

const { supabase } = require('../db/supabase');
const { ok, forbidden, badRequest } = require('../util/response');
const { envelopeFor } = require('./send');

/**
 * GET /conversations/:id/messages?before=<id>&limit=50
 * Returns envelopes + the ciphertext addressed to THIS device.
 * If the user's device was enrolled after a message was sent, it will not
 * appear in the recipient set and will not be readable — the server returns
 * the envelope anyway so the client can show "message sent before you joined".
 */
async function listMessages(req, res, { params, query }) {
  const convId = params.id;
  const limit = Math.min(Number(query.limit) || 50, 200);
  const before = query.before || null;

  // Membership check
  const { data: me } = await supabase
    .from('conversation_members')
    .select('user_id').eq('conversation_id', convId)
    .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!me) return forbidden(res, 'Not a conversation member');

  let q = supabase.from('messages')
    .select('*')
    .eq('conversation_id', convId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) {
    // Cursor = created_at of message with id=before
    const { data: cursor } = await supabase
      .from('messages').select('created_at').eq('id', before).maybeSingle();
    if (cursor) q = q.lt('created_at', cursor.created_at);
  }

  const { data: msgs, error } = await q;
  if (error) return badRequest(res, 'Query failed');

  if (!msgs || msgs.length === 0) {
    return ok(res, { messages: [], next_cursor: null });
  }

  // Pull ciphertext for THIS device first
  const ids = msgs.map((m) => m.id);
  const { data: myCopies } = await supabase
    .from('message_recipients')
    .select('message_id, ciphertext, nonce, delivered_at, read_at, recipient_device_id')
    .in('message_id', ids)
    .eq('recipient_device_id', req.auth.deviceId);

  const copyMap = new Map((myCopies || []).map((c) => [c.message_id, c]));

  // For messages where THIS device wasn't a recipient (device enrolled after
  // the message was sent), fall back to any other device owned by the same
  // user. The client can decrypt these using the device secret it obtained
  // during pairing (key-sharing).
  const missingIds = ids.filter((id) => !copyMap.has(id));
  if (missingIds.length > 0) {
    const { data: siblingDevices } = await supabase
      .from('devices')
      .select('id')
      .eq('user_id', req.auth.userId)
      .neq('id', req.auth.deviceId);
    const siblingIds = (siblingDevices || []).map((d) => d.id);
    if (siblingIds.length > 0) {
      const { data: fallbackCopies } = await supabase
        .from('message_recipients')
        .select('message_id, ciphertext, nonce, delivered_at, read_at, recipient_device_id')
        .in('message_id', missingIds)
        .in('recipient_device_id', siblingIds);
      for (const c of fallbackCopies || []) {
        // First fallback wins; duplicates across sibling devices all decrypt
        // to the same plaintext anyway.
        if (!copyMap.has(c.message_id)) copyMap.set(c.message_id, c);
      }
    }
  }

  // Pull all reactions for these messages
  const { data: rxns } = await supabase
    .from('message_reactions')
    .select('message_id, user_id, emoji, created_at')
    .in('message_id', ids);

  const rxnMap = new Map();
  for (const r of rxns || []) {
    if (!rxnMap.has(r.message_id)) rxnMap.set(r.message_id, []);
    rxnMap.get(r.message_id).push({ user_id: r.user_id, emoji: r.emoji, created_at: r.created_at });
  }

  // Aggregate delivery/read across other-than-self devices so the sender can
  // see "delivered to SOMEONE else" and "read by SOMEONE else".
  const { data: aggRows } = await supabase
    .from('message_recipients')
    .select('message_id, delivered_at, read_at, recipient_device_id')
    .in('message_id', ids);

  const aggMap = new Map();
  const authDevice = req.auth.deviceId;
  for (const r of aggRows || []) {
    if (r.recipient_device_id === authDevice) continue; // skip self-device row
    const cur = aggMap.get(r.message_id) || { anyDelivered: false, anyRead: false };
    if (r.delivered_at) cur.anyDelivered = true;
    if (r.read_at) cur.anyRead = true;
    aggMap.set(r.message_id, cur);
  }

  const out = msgs.map((m) => {
    const c = copyMap.get(m.id);
    const agg = aggMap.get(m.id);
    return {
      ...envelopeFor(m),
      // null means "no device of this user was a recipient" (very old / alien)
      ciphertext: c?.ciphertext ?? null,
      nonce: c?.nonce ?? null,
      // If this copy was for a sibling device (pre-pairing), the client needs
      // to decrypt using the shared device secret it received during pairing.
      recipient_device_id: c?.recipient_device_id ?? null,
      delivered_at: c?.delivered_at || null,
      read_at: c?.read_at || null,
      any_delivered_at: agg?.anyDelivered || false,
      any_read_at: agg?.anyRead || false,
      reactions: rxnMap.get(m.id) || [],
    };
  });

  const nextCursor = msgs.length === limit ? msgs[msgs.length - 1].id : null;
  ok(res, { messages: out, next_cursor: nextCursor });
}

module.exports = { listMessages };
