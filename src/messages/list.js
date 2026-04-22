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

  // Pull ciphertext for THIS device only
  const ids = msgs.map((m) => m.id);
  const { data: myCopies } = await supabase
    .from('message_recipients')
    .select('message_id, ciphertext, nonce, delivered_at, read_at')
    .in('message_id', ids)
    .eq('recipient_device_id', req.auth.deviceId);

  const copyMap = new Map((myCopies || []).map((c) => [c.message_id, c]));

  const out = msgs.map((m) => {
    const c = copyMap.get(m.id);
    return {
      ...envelopeFor(m),
      // null means "this device wasn't a recipient" (probably enrolled later)
      ciphertext: c ? Buffer.from(c.ciphertext).toString('base64') : null,
      nonce: c ? Buffer.from(c.nonce).toString('base64') : null,
      delivered_at: c?.delivered_at || null,
      read_at: c?.read_at || null,
    };
  });

  const nextCursor = msgs.length === limit ? msgs[msgs.length - 1].id : null;
  ok(res, { messages: out, next_cursor: nextCursor });
}

module.exports = { listMessages };
