const { getConnection } = require('./connections');
const supabase = require('../db/supabase');

async function handleMessage(userId, data, ws) {
  if (data.type === 'MESSAGE_SEND') {
    // Deliver to recipient directly if online
    const receiverWs = getConnection(data.recipientId);
    
    // Save to DB
    const { data: msgData, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: data.conversationId,
        sender_id: userId,
        encrypted_content: data.encryptedContent,
        message_type: data.messageType || 'text',
        media_url: data.mediaUrl || null
      })
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
      createdAt: msgData.created_at
    };

    if (receiverWs && receiverWs.readyState === 1 /* OPEN */) {
      receiverWs.send(JSON.stringify(payload));
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
    const receiverWs = getConnection(data.recipientId);
    if (receiverWs && receiverWs.readyState === 1) {
      data.senderId = userId; // inject sender id
      receiverWs.send(JSON.stringify(data));
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
  } else if (data.type === 'USER_STATUS') {
    // Basic presence logic
    // You could broadcast to all active connections that have this user in their conversations
  }
}

module.exports = {
  handleMessage
};
