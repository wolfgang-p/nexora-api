'use strict';

/**
 * Poll voting, result read, and close.
 *
 *   POST   /polls/:id/vote     { option_ids: [uuid,...] }    — cast vote(s)
 *   DELETE /polls/:id/vote                                   — retract all my votes
 *   GET    /polls/:id/results                                — tallies + (my vote)
 *   POST   /polls/:id/close    (creator only)                — early-close
 *
 * Single-choice polls replace the voter's existing vote. Multi-choice
 * polls accept an array and store the diff (delete removed, insert
 * added). Anonymous polls hide voter identities in results from
 * everyone except the poll creator and admins.
 *
 * Server-side correctness: every mutation checks membership of the
 * conversation. E2E is preserved because server only sees option IDs,
 * never option text.
 */

const { supabase } = require('../db/supabase');
const { readJson, ok, badRequest, forbidden, notFound, serverError } = require('../util/response');
const { audit } = require('../util/audit');
const { broadcastToDevices } = require('../ws/dispatch');

async function loadPollAndAuthorize(req, pollId) {
  const { data: poll } = await supabase.from('polls')
    .select('id, conversation_id, creator_user_id, multi_choice, anonymous, closes_at, closed_at, message_id')
    .eq('id', pollId).maybeSingle();
  if (!poll) return { error: 'notfound' };
  const { data: m } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', poll.conversation_id)
    .eq('user_id', req.auth.userId).is('left_at', null).maybeSingle();
  if (!m) return { error: 'forbidden' };
  return { poll };
}

async function vote(req, res, { params }) {
  const { poll, error } = await loadPollAndAuthorize(req, params.id);
  if (error === 'notfound')  return notFound(res, 'Poll not found');
  if (error === 'forbidden') return forbidden(res);
  if (poll.closed_at || (poll.closes_at && new Date(poll.closes_at) < new Date())) {
    return badRequest(res, 'Poll closed');
  }

  const body = await readJson(req).catch(() => null);
  if (!body || !Array.isArray(body.option_ids)) return badRequest(res, 'option_ids array required');

  const ids = body.option_ids.filter((x) => typeof x === 'string');
  if (ids.length === 0) return badRequest(res, 'at least one option_id');
  if (!poll.multi_choice && ids.length > 1) return badRequest(res, 'Poll is single-choice');

  // Verify every option belongs to this poll.
  const { data: validOpts } = await supabase.from('poll_options')
    .select('id').eq('poll_id', poll.id).in('id', ids);
  if (!validOpts || validOpts.length !== ids.length) {
    return badRequest(res, 'Unknown option_id');
  }

  // Replace previous votes atomically-ish: delete then insert.
  await supabase.from('poll_votes')
    .delete().eq('poll_id', poll.id).eq('user_id', req.auth.userId);
  const rows = ids.map((oid) => ({ poll_id: poll.id, option_id: oid, user_id: req.auth.userId }));
  const { error: insErr } = await supabase.from('poll_votes').insert(rows);
  if (insErr) return serverError(res, 'Vote failed', insErr);

  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'poll.vote', targetType: 'poll', targetId: poll.id,
    metadata: { option_ids: ids, multi: poll.multi_choice }, req,
  });

  await broadcastPollUpdate(poll);
  ok(res, { ok: true });
}

async function retract(req, res, { params }) {
  const { poll, error } = await loadPollAndAuthorize(req, params.id);
  if (error === 'notfound')  return notFound(res, 'Poll not found');
  if (error === 'forbidden') return forbidden(res);
  await supabase.from('poll_votes').delete()
    .eq('poll_id', poll.id).eq('user_id', req.auth.userId);
  await broadcastPollUpdate(poll);
  ok(res, { ok: true });
}

async function results(req, res, { params }) {
  const { poll, error } = await loadPollAndAuthorize(req, params.id);
  if (error === 'notfound')  return notFound(res, 'Poll not found');
  if (error === 'forbidden') return forbidden(res);

  const [votes, myVotes] = await Promise.all([
    supabase.from('poll_votes')
      .select('option_id, user_id, voted_at')
      .eq('poll_id', poll.id)
      .then((r) => r.data || []),
    supabase.from('poll_votes')
      .select('option_id')
      .eq('poll_id', poll.id).eq('user_id', req.auth.userId)
      .then((r) => r.data || []),
  ]);

  const tally = {};
  const voters = {};
  for (const v of votes) {
    tally[v.option_id] = (tally[v.option_id] || 0) + 1;
    if (!poll.anonymous || poll.creator_user_id === req.auth.userId || req.auth.user?.is_admin) {
      if (!voters[v.option_id]) voters[v.option_id] = [];
      voters[v.option_id].push(v.user_id);
    }
  }

  ok(res, {
    poll: {
      id: poll.id,
      closed_at: poll.closed_at,
      closes_at: poll.closes_at,
      multi_choice: poll.multi_choice,
      anonymous: poll.anonymous,
    },
    tallies: tally,
    voters: poll.anonymous && poll.creator_user_id !== req.auth.userId && !req.auth.user?.is_admin ? null : voters,
    my_votes: myVotes.map((v) => v.option_id),
    total_voters: new Set(votes.map((v) => v.user_id)).size,
  });
}

async function close(req, res, { params }) {
  const { poll, error } = await loadPollAndAuthorize(req, params.id);
  if (error === 'notfound')  return notFound(res, 'Poll not found');
  if (error === 'forbidden') return forbidden(res);
  if (poll.creator_user_id !== req.auth.userId && !req.auth.user?.is_admin) return forbidden(res);
  await supabase.from('polls').update({ closed_at: new Date().toISOString() }).eq('id', poll.id);
  await broadcastPollUpdate(poll);
  audit({
    userId: req.auth.userId, deviceId: req.auth.deviceId,
    action: 'poll.close', targetType: 'poll', targetId: poll.id, req,
  });
  ok(res, { ok: true });
}

async function broadcastPollUpdate(poll) {
  const { data: members } = await supabase.from('conversation_members')
    .select('user_id').eq('conversation_id', poll.conversation_id).is('left_at', null);
  const userIds = (members || []).map((m) => m.user_id);
  const { data: devs } = await supabase.from('devices')
    .select('id').in('user_id', userIds).is('revoked_at', null);
  broadcastToDevices((devs || []).map((d) => d.id), () => ({
    type: 'poll.update',
    poll_id: poll.id,
    conversation_id: poll.conversation_id,
  }));
}

module.exports = { vote, retract, results, close };
