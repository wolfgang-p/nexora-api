const { sendJSON, sendError } = require('../utils/response');
const supabase = require('../db/supabase');

async function handleListConversations(req, res) {
  // Find conversations user is part of
  const { data: participants, error } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', req.user.userId)
    .is('deleted_at', null)
    .is('archived_at', null);

  if (error) return sendError(res, 500, error.message);
  if (!participants || participants.length === 0) return sendJSON(res, 200, []);

  const conversationIds = participants.map(p => p.conversation_id);

  const { data: conversations, error: convError } = await supabase
    .from('conversations')
    .select(`
      id, type, name, avatar_url, created_at,
      conversation_participants (
        user_id,
        users (id, username, display_name, avatar_url, public_key, is_online)
      )
    `)
    .in('id', conversationIds)
    .order('created_at', { ascending: false });

  if (convError) return sendError(res, 500, convError.message);

  // Fetch blocked user IDs for the current user
  const { data: blockedRows } = await supabase
    .from('blocked_users')
    .select('blocked_id')
    .eq('blocker_id', req.user.userId);
  const blockedIds = new Set((blockedRows || []).map(b => b.blocked_id));

  // Annotate each conversation with isBlocked
  const annotated = (conversations || []).map(conv => {
    const otherParticipants = (conv.conversation_participants || [])
      .map(p => p.users)
      .filter(u => u && u.id !== req.user.userId);
    const isBlocked = conv.type === 'direct' && otherParticipants.some(u => blockedIds.has(u.id));
    return { ...conv, isBlocked };
  });

  sendJSON(res, 200, annotated);
}

async function handleCreateConversation(req, res, body) {
  const { type, participant_ids } = body;
  // Make sure current user is included
  const participants = Array.from(new Set([...(participant_ids || []), req.user.userId]));

  if (type === 'direct' && participants.length !== 2) {
    return sendError(res, 400, 'Direct conversations must have exactly 2 participants');
  }

  if (type === 'direct' && participants.length === 2) {
    const { data: existingParts, error: checkErr } = await supabase
      .from('conversation_participants')
      .select('conversation_id')
      .in('user_id', participants);
      
    if (!checkErr && existingParts) {
      // Group by conversation_id to find a match
      const countMap = {};
      let foundConvId = null;
      for (const p of existingParts) {
        countMap[p.conversation_id] = (countMap[p.conversation_id] || 0) + 1;
        if (countMap[p.conversation_id] === 2) {
          foundConvId = p.conversation_id;
          break;
        }
      }
      if (foundConvId) {
        // Return existing conversation
        const { data: existingConv } = await supabase
          .from('conversations')
          .select('*')
          .eq('id', foundConvId)
          .single();
        if (existingConv) {
          return sendJSON(res, 200, existingConv);
        }
      }
    }
  }

  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .insert({ 
      type, 
      created_by: req.user.userId,
      name: body.name || null,
      avatar_url: body.avatarUrl || null
    })
    .select()
    .single();

  if (convError) return sendError(res, 500, convError.message);

  const participantInserts = participants.map(id => ({
    conversation_id: conversation.id,
    user_id: id
  }));

  const { error: partError } = await supabase
    .from('conversation_participants')
    .insert(participantInserts);

  if (partError) return sendError(res, 500, partError.message);

  sendJSON(res, 201, conversation);
}

async function handleGetMessages(req, res, urlObj, conversationId) {
  // URL may have ?cursor=
  const url = new URL(urlObj, `http://${req.headers.host}`);
  const cursor = url.searchParams.get('cursor');

  let query = supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (cursor) {
    query = query.lt('created_at', cursor);
  }

  const { data: messages, error } = await query;
  if (error) return sendError(res, 500, error.message);

  sendJSON(res, 200, messages);
}

async function handleArchiveConversation(req, res, conversationId) {
  const { error } = await supabase
    .from('conversation_participants')
    .update({ archived_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('user_id', req.user.userId);

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, { success: true });
}

async function handleUnarchiveConversation(req, res, conversationId) {
  const { error } = await supabase
    .from('conversation_participants')
    .update({ archived_at: null })
    .eq('conversation_id', conversationId)
    .eq('user_id', req.user.userId);

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, { success: true });
}

async function handleDeleteForMe(req, res, conversationId) {
  const { error } = await supabase
    .from('conversation_participants')
    .update({ deleted_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('user_id', req.user.userId);

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, { success: true });
}

async function handleDeleteForAll(req, res, conversationId) {
  // Verify requester is a participant
  const { data: participant } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', req.user.userId)
    .single();

  if (!participant) return sendError(res, 403, 'Not a participant');

  // Delete all messages
  await supabase
    .from('messages')
    .delete()
    .eq('conversation_id', conversationId);

  // Delete all participants
  await supabase
    .from('conversation_participants')
    .delete()
    .eq('conversation_id', conversationId);

  // Delete the conversation
  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('id', conversationId);

  if (error) return sendError(res, 500, error.message);
  sendJSON(res, 200, { success: true });
}

async function handleListArchivedConversations(req, res) {
  const { data: participants, error } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', req.user.userId)
    .not('archived_at', 'is', null)
    .is('deleted_at', null);

  if (error) return sendError(res, 500, error.message);
  if (!participants || participants.length === 0) return sendJSON(res, 200, []);

  const conversationIds = participants.map(p => p.conversation_id);

  const { data: conversations, error: convError } = await supabase
    .from('conversations')
    .select(`
      id, type, name, avatar_url, created_at,
      conversation_participants (
        user_id,
        users (id, username, display_name, avatar_url, public_key, is_online)
      )
    `)
    .in('id', conversationIds)
    .order('created_at', { ascending: false });

  if (convError) return sendError(res, 500, convError.message);
  sendJSON(res, 200, conversations);
}

module.exports = {
  handleListConversations,
  handleCreateConversation,
  handleGetMessages,
  handleArchiveConversation,
  handleUnarchiveConversation,
  handleDeleteForMe,
  handleDeleteForAll,
  handleListArchivedConversations
};
