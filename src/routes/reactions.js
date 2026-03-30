const { sendJSON, sendError } = require('../utils/response');
const supabase = require('../db/supabase');
const { getConnection } = require('../ws/connections');

// Verify the user is a participant of the conversation the message belongs to
async function verifyMessageAccess(messageId, userId) {
  const { data: msg, error } = await supabase
    .from('messages')
    .select('id, conversation_id')
    .eq('id', messageId)
    .single();

  if (error || !msg) return null;

  const { data: participant } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', msg.conversation_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!participant) return null;
  return msg;
}

// GET /messages/:id/reactions
async function handleGetReactions(req, res, messageId) {
  const msg = await verifyMessageAccess(messageId, req.user.userId);
  if (!msg) return sendError(res, 403, 'Forbidden');

  const { data, error } = await supabase
    .from('message_reactions')
    .select('emoji, user_id, created_at')
    .eq('message_id', messageId)
    .order('created_at', { ascending: true });

  if (error) return sendError(res, 500, error.message);

  // Group by emoji
  const grouped = {};
  for (const row of (data || [])) {
    if (!grouped[row.emoji]) {
      grouped[row.emoji] = { emoji: row.emoji, userIds: [], count: 0 };
    }
    grouped[row.emoji].userIds.push(row.user_id);
    grouped[row.emoji].count++;
  }

  sendJSON(res, 200, Object.values(grouped));
}

// POST /messages/:id/reactions  body: { emoji }
async function handleAddReaction(req, res, messageId, body) {
  const { emoji } = body || {};
  if (!emoji || typeof emoji !== 'string' || emoji.length > 8) {
    return sendError(res, 400, 'Invalid emoji');
  }

  const msg = await verifyMessageAccess(messageId, req.user.userId);
  if (!msg) return sendError(res, 403, 'Forbidden');

  const { error } = await supabase
    .from('message_reactions')
    .insert({ message_id: messageId, user_id: req.user.userId, emoji });

  if (error) {
    // 23505 = unique_violation (already reacted)
    if (error.code === '23505') return sendError(res, 409, 'Already reacted');
    return sendError(res, 500, error.message);
  }

  // Broadcast REACTION_ADD to all conversation participants via WS
  await broadcastReactionEvent(msg.conversation_id, {
    type: 'REACTION_ADD',
    messageId,
    conversationId: msg.conversation_id,
    userId: req.user.userId,
    emoji,
  }, req.user.userId);

  sendJSON(res, 200, { ok: true });
}

// DELETE /messages/:id/reactions/:emoji
async function handleRemoveReaction(req, res, messageId, emoji) {
  const decodedEmoji = decodeURIComponent(emoji);

  const msg = await verifyMessageAccess(messageId, req.user.userId);
  if (!msg) return sendError(res, 403, 'Forbidden');

  const { error } = await supabase
    .from('message_reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('user_id', req.user.userId)
    .eq('emoji', decodedEmoji);

  if (error) return sendError(res, 500, error.message);

  // Broadcast REACTION_REMOVE to all conversation participants via WS
  await broadcastReactionEvent(msg.conversation_id, {
    type: 'REACTION_REMOVE',
    messageId,
    conversationId: msg.conversation_id,
    userId: req.user.userId,
    emoji: decodedEmoji,
  }, req.user.userId);

  sendJSON(res, 200, { ok: true });
}

async function broadcastReactionEvent(conversationId, payload, senderId) {
  const { data: participants } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId);

  if (!participants) return;

  const payloadStr = JSON.stringify(payload);
  for (const { user_id } of participants) {
    const ws = getConnection(user_id);
    if (ws && ws.readyState === 1) {
      ws.send(payloadStr);
    }
  }
}

module.exports = {
  handleGetReactions,
  handleAddReaction,
  handleRemoveReaction,
};
