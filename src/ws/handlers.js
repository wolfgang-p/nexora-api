const { getConnection } = require('./connections');
const supabase = require('../db/supabase');

async function getConversationParticipants(conversationId, senderId) {
  const { data, error } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .is('deleted_at', null);
    
  if (error || !data) return [];
  return data.map(p => p.user_id).filter(id => id !== senderId);
}

async function isBlocked(senderId, receiverId) {
  const { data } = await supabase
    .from('blocked_users')
    .select('id')
    .eq('blocker_id', receiverId)
    .eq('blocked_id', senderId)
    .maybeSingle();
  return !!data;
}

async function handleMessage(userId, data, ws) {
  if (data.type === 'MESSAGE_SEND') {

    // Check only_admins_send restriction for groups
    const { data: convSettings } = await supabase
      .from('conversations')
      .select('only_admins_send, type')
      .eq('id', data.conversationId)
      .single();

    if (convSettings && convSettings.type === 'group' && convSettings.only_admins_send) {
      const { data: participant } = await supabase
        .from('conversation_participants')
        .select('role')
        .eq('conversation_id', data.conversationId)
        .eq('user_id', userId)
        .single();

      if (participant && participant.role === 'member') {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Only admins can send messages in this group' }));
        }
        return;
      }
    }

    // Save to DB
    const insertData = {
      conversation_id: data.conversationId,
      sender_id: userId,
      encrypted_content: data.encryptedContent,
      message_type: data.messageType || 'text',
      media_url: data.mediaUrl || null
    };
    if (data.messageType === 'voice' && data.duration) {
      insertData.duration = data.duration;
    }

    const { data: msgData, error } = await supabase
      .from('messages')
      .insert(insertData)
      .select('id, created_at')
      .single();

    if (error) {
      console.error('Error saving message:', error);
      return;
    }

    const payload = {
      type: 'MESSAGE_RECEIVE',
      messageId: msgData.id,
      conversationId: data.conversationId,
      senderId: userId,
      encryptedContent: data.encryptedContent,
      messageType: data.messageType || 'text',
      mediaUrl: data.mediaUrl || null,
      duration: data.duration || null,
      createdAt: msgData.created_at
    };

    const targetUserIds = await getConversationParticipants(data.conversationId, userId);
    for (const targetId of targetUserIds) {
      const blocked = await isBlocked(userId, targetId);
      if (blocked) continue;
      const receiverWs = getConnection(targetId);
      if (receiverWs && receiverWs.readyState === 1) {
        receiverWs.send(JSON.stringify(payload));
      }
    }

    // Notify sender that it is sent successfully
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'MESSAGE_SENT',
        messageId: msgData.id,
        conversationId: data.conversationId,
        temporaryId: data.temporaryId // From frontend
      }));
    }
  } else if (data.type === 'MESSAGE_DELIVERED' || data.type === 'MESSAGE_READ' || 
             data.type === 'TYPING_START' || data.type === 'TYPING_STOP') {
    const targetUserIds = await getConversationParticipants(data.conversationId, userId);
    
    for (const targetId of targetUserIds) {
      const receiverWs = getConnection(targetId);
      if (receiverWs && receiverWs.readyState === 1) {
        data.senderId = userId; // inject sender id
        receiverWs.send(JSON.stringify(data));
      }
    }
    
    // update db (if MESSAGE_DELIVERED or MESSAGE_READ)
    if (data.type === 'MESSAGE_DELIVERED' && data.messageId) {
      await supabase.from('messages').update({ delivered_at: new Date() }).eq('id', data.messageId);
    } else if (data.type === 'MESSAGE_READ' && data.messageId) {
      await supabase.from('messages').update({ read_at: new Date() }).eq('id', data.messageId);
      await supabase.from('conversation_participants')
        .update({ last_read_message_id: data.messageId })
        .eq('user_id', userId)
        .eq('conversation_id', data.conversationId);
    }
  } else if (data.type === 'MESSAGE_DELETE') {
    // Broadcast deletion to other participants
    const targetUserIds = await getConversationParticipants(data.conversationId, userId);
    const payload = {
      type: 'MESSAGE_DELETED',
      messageId: data.messageId,
      conversationId: data.conversationId,
      senderId: userId
    };
    for (const targetId of targetUserIds) {
      const receiverWs = getConnection(targetId);
      if (receiverWs && receiverWs.readyState === 1) {
        receiverWs.send(JSON.stringify(payload));
      }
    }
  } else if (data.type === 'USER_STATUS') {
    // Basic presence logic
  } else if (data.type === 'CALL_INITIATE') {
    // Caller wants to start a call with a specific user
    const receiverWs = getConnection(data.recipientId);
    if (receiverWs && receiverWs.readyState === 1) {
      receiverWs.send(JSON.stringify({
        type: 'CALL_INCOMING',
        callId: data.callId,
        callerId: userId,
        callerName: data.callerName,
        callerAvatar: data.callerAvatar,
        callType: data.callType, // 'audio' | 'video'
      }));
    } else {
      // Recipient offline
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'CALL_UNAVAILABLE',
          callId: data.callId,
          recipientId: data.recipientId,
        }));
      }
    }
  } else if (data.type === 'CALL_ACCEPT') {
    const callerWs = getConnection(data.callerId);
    if (callerWs && callerWs.readyState === 1) {
      callerWs.send(JSON.stringify({
        type: 'CALL_ACCEPTED',
        callId: data.callId,
        responderId: userId,
      }));
    }
  } else if (data.type === 'CALL_REJECT' || data.type === 'CALL_END') {
    const targetWs = getConnection(data.targetId);
    if (targetWs && targetWs.readyState === 1) {
      targetWs.send(JSON.stringify({
        type: data.type === 'CALL_REJECT' ? 'CALL_REJECTED' : 'CALL_ENDED',
        callId: data.callId,
        senderId: userId,
      }));
    }
  } else if (data.type === 'WEBRTC_OFFER' || data.type === 'WEBRTC_ANSWER' || data.type === 'WEBRTC_ICE_CANDIDATE') {
    // Relay WebRTC signaling messages directly to the target peer
    const targetWs = getConnection(data.targetId);
    if (targetWs && targetWs.readyState === 1) {
      targetWs.send(JSON.stringify({
        type: data.type,
        callId: data.callId,
        senderId: userId,
        payload: data.payload, // SDP or ICE candidate
      }));
    }
  }
}

module.exports = {
  handleMessage
};
