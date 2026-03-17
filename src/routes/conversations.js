const { sendJSON, sendError } = require('../utils/response');
const supabase = require('../db/supabase');

async function handleListConversations(req, res) {
  // Find conversations user is part of
  const { data: participants, error } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', req.user.userId);

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

module.exports = {
  handleListConversations,
  handleCreateConversation,
  handleGetMessages
};
