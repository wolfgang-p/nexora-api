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

  // Hydrate polls for any poll-kind message in this page. We only pull
  // server-owned metadata — options texts live in the ciphertext.
  const pollMsgIds = msgs.filter((m) => m.kind === 'poll').map((m) => m.id);
  const pollByMsg = new Map();
  if (pollMsgIds.length) {
    const { data: polls } = await supabase.from('polls')
      .select('id, message_id, multi_choice, anonymous, closes_at, closed_at')
      .in('message_id', pollMsgIds);
    const pollIds = (polls || []).map((p) => p.id);
    const { data: opts } = pollIds.length
      ? await supabase.from('poll_options').select('id, poll_id, position').in('poll_id', pollIds).order('position')
      : { data: [] };
    const { data: votes } = pollIds.length
      ? await supabase.from('poll_votes').select('poll_id, option_id, user_id').in('poll_id', pollIds)
      : { data: [] };
    const tallies = {};
    const myVotes = {};
    for (const v of (votes || [])) {
      tallies[v.poll_id] = tallies[v.poll_id] || {};
      tallies[v.poll_id][v.option_id] = (tallies[v.poll_id][v.option_id] || 0) + 1;
      if (v.user_id === req.auth.userId) {
        myVotes[v.poll_id] = myVotes[v.poll_id] || [];
        myVotes[v.poll_id].push(v.option_id);
      }
    }
    for (const p of (polls || [])) {
      pollByMsg.set(p.message_id, {
        id: p.id,
        multi_choice: p.multi_choice,
        anonymous: p.anonymous,
        closes_at: p.closes_at,
        closed_at: p.closed_at,
        options: (opts || []).filter((o) => o.poll_id === p.id).map((o) => ({ id: o.id, position: o.position })),
        tallies: tallies[p.id] || {},
        my_votes: myVotes[p.id] || [],
      });
    }
  }

  // Thread metadata: for each message shown in the page, if it's a root
  // (id appears in some other message's thread_root_id), attach
  // {reply_count, latest_reply_at, last_read_at}.
  const threadMeta = new Map();
  if (ids.length) {
    const { data: replies } = await supabase.from('messages')
      .select('thread_root_id, created_at')
      .in('thread_root_id', ids)
      .order('created_at', { ascending: false });
    for (const r of (replies || [])) {
      const cur = threadMeta.get(r.thread_root_id) || { reply_count: 0, latest_reply_at: null };
      cur.reply_count += 1;
      if (!cur.latest_reply_at || r.created_at > cur.latest_reply_at) cur.latest_reply_at = r.created_at;
      threadMeta.set(r.thread_root_id, cur);
    }
    if (threadMeta.size > 0) {
      const { data: reads } = await supabase.from('thread_reads')
        .select('thread_root_id, last_read_at')
        .eq('user_id', req.auth.userId)
        .in('thread_root_id', Array.from(threadMeta.keys()));
      for (const rd of (reads || [])) {
        const m = threadMeta.get(rd.thread_root_id);
        if (m) m.last_read_at = rd.last_read_at;
      }
    }
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
      poll: pollByMsg.get(m.id) || null,
      thread: threadMeta.get(m.id) || null,
    };
  });

  const nextCursor = msgs.length === limit ? msgs[msgs.length - 1].id : null;
  ok(res, { messages: out, next_cursor: nextCursor });
}

module.exports = { listMessages };
