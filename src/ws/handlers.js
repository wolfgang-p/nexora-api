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

async function getWorkspaceChannelParticipants(channelId, senderId) {
  const { data: channel } = await supabase
    .from('workspace_channels')
    .select('workspace_id, is_private')
    .eq('id', channelId)
    .single();

  if (!channel) return [];

  if (channel.is_private) {
    const { data } = await supabase
      .from('workspace_channel_members')
      .select('user_id')
      .eq('channel_id', channelId);
    if (!data) return [];
    return data.map(p => p.user_id).filter(id => id !== senderId);
  } else {
    const { data } = await supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', channel.workspace_id);
    if (!data) return [];
    return data.map(p => p.user_id).filter(id => id !== senderId);
  }
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

// Pending outgoing calls: callId → { callerUserId, recipientId, recipientName, timer }
const pendingCalls = new Map();

function cancelPendingCall(callId) {
  const pending = pendingCalls.get(callId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCalls.delete(callId);
  }
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
        temporaryId: data.temporaryId
      }));
    }
  } else if (data.type === 'MESSAGE_DELIVERED' || data.type === 'MESSAGE_READ' || 
             data.type === 'TYPING_START' || data.type === 'TYPING_STOP') {
    const targetUserIds = await getConversationParticipants(data.conversationId, userId);
    
    for (const targetId of targetUserIds) {
      const receiverWs = getConnection(targetId);
      if (receiverWs && receiverWs.readyState === 1) {
        data.senderId = userId;
        receiverWs.send(JSON.stringify(data));
      }
    }
    
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
    const recipientWs = getConnection(data.recipientId);

    if (recipientWs && recipientWs.readyState === 1) {
      // Recipient is online — deliver ring and start 30s timeout
      recipientWs.send(JSON.stringify({
        type: 'CALL_INCOMING',
        callId: data.callId,
        callerId: userId,
        callerName: data.callerName,
        callerAvatar: data.callerAvatar,
        callType: data.callType,
      }));

      const recipientName = data.recipientName || 'Unbekannt';

      const timer = setTimeout(() => {
        pendingCalls.delete(data.callId);
        // Notify caller: no answer after 30s
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'CALL_UNAVAILABLE',
            callId: data.callId,
            recipientId: data.recipientId,
            recipientName,
          }));
        }
        // Cancel ring on recipient side
        if (recipientWs && recipientWs.readyState === 1) {
          recipientWs.send(JSON.stringify({ type: 'CALL_ENDED', callId: data.callId }));
        }
      }, 30000);

      pendingCalls.set(data.callId, { callerUserId: userId, recipientId: data.recipientId, recipientName, timer });
    } else {
      // Recipient offline — notify caller immediately
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'CALL_UNAVAILABLE',
          callId: data.callId,
          recipientId: data.recipientId,
          recipientName: data.recipientName || 'Unbekannt',
        }));
      }
    }
  } else if (data.type === 'CALL_ACCEPT') {
    cancelPendingCall(data.callId);

    const callerWs = getConnection(data.callerId);
    if (callerWs && callerWs.readyState === 1) {
      callerWs.send(JSON.stringify({
        type: 'CALL_ACCEPTED',
        callId: data.callId,
        responderId: userId,
      }));
    }
  } else if (data.type === 'CALL_REJECT' || data.type === 'CALL_END') {
    cancelPendingCall(data.callId);

    const targetWs = getConnection(data.targetId);
    if (targetWs && targetWs.readyState === 1) {
      targetWs.send(JSON.stringify({
        type: data.type === 'CALL_REJECT' ? 'CALL_REJECTED' : 'CALL_ENDED',
        callId: data.callId,
        senderId: userId,
      }));
    }
  } else if (data.type === 'WEBRTC_OFFER' || data.type === 'WEBRTC_ANSWER' || data.type === 'WEBRTC_ICE_CANDIDATE') {
    const targetWs = getConnection(data.targetId);
    if (targetWs && targetWs.readyState === 1) {
      targetWs.send(JSON.stringify({
        type: data.type,
        callId: data.callId,
        senderId: userId,
        payload: data.payload,
      }));
    }
  } else if (data.type === 'REACTION_ADD' || data.type === 'REACTION_REMOVE') {
    const { messageId, conversationId, emoji } = data;
    if (!messageId || !conversationId || !emoji) return;

    // Verify sender is a participant
    const { data: participant } = await supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!participant) return;

    if (data.type === 'REACTION_ADD') {
      const { error } = await supabase
        .from('message_reactions')
        .insert({ message_id: messageId, user_id: userId, emoji });
      if (error && error.code !== '23505') return; // ignore duplicate
    } else {
      await supabase
        .from('message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', userId)
        .eq('emoji', emoji);
    }

    // Broadcast to all conversation participants (including sender for multi-device)
    const { data: participants } = await supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId);

    const payload = JSON.stringify({
      type: data.type,
      messageId,
      conversationId,
      userId,
      emoji,
    });

    for (const { user_id } of (participants || [])) {
      const receiverWs = getConnection(user_id);
      if (receiverWs && receiverWs.readyState === 1) {
        receiverWs.send(payload);
      }
    }
  } else if (data.type === 'WS_MESSAGE_SEND') {
    // Workspace messaging
    const insertData = {
      channel_id: data.channelId,
      sender_id: userId,
      encrypted_content: data.encryptedContent,
      message_type: data.messageType || 'text',
      media_url: data.mediaUrl || null,
      file_name: data.fileName || null,
      file_size: data.fileSize || null
    };

    const { data: msgData, error } = await supabase
      .from('workspace_messages')
      .insert(insertData)
      .select('*, sender:users(id, display_name, avatar_url, public_key)')
      .single();

    if (error) {
      console.error('Error saving workspace message:', error);
      return;
    }

    const payload = {
      type: 'WS_MESSAGE_RECEIVE',
      messageId: msgData.id,
      channelId: data.channelId,
      senderId: userId,
      senderName: msgData.sender?.display_name,
      senderAvatar: msgData.sender?.avatar_url,
      encryptedContent: data.encryptedContent,
      messageType: data.messageType || 'text',
      mediaUrl: data.mediaUrl || null,
      fileName: data.fileName || null,
      fileSize: data.fileSize || null,
      createdAt: msgData.created_at
    };

    const targetUserIds = await getWorkspaceChannelParticipants(data.channelId, userId);
    for (const targetId of targetUserIds) {
      const receiverWs = getConnection(targetId);
      if (receiverWs && receiverWs.readyState === 1) {
        receiverWs.send(JSON.stringify(payload));
      }
    }

    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'WS_MESSAGE_SENT',
        messageId: msgData.id,
        channelId: data.channelId,
        temporaryId: data.temporaryId
      }));
    }
  } else if (data.type === 'WS_TYPING_START' || data.type === 'WS_TYPING_STOP') {
    const targetUserIds = await getWorkspaceChannelParticipants(data.channelId, userId);
    const { data: user } = await supabase.from('users').select('display_name').eq('id', userId).single();
    
    for (const targetId of targetUserIds) {
      const receiverWs = getConnection(targetId);
      if (receiverWs && receiverWs.readyState === 1) {
        receiverWs.send(JSON.stringify({
          type: data.type,
          channelId: data.channelId,
          senderId: userId,
          senderName: user?.display_name
        }));
      }
    }
  }
}

module.exports = {
  handleMessage
};
