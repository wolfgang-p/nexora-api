-- Migration 005: Group roles, group settings, voice messages

-- 1. Add role to conversation_participants (owner, admin, member)
ALTER TABLE conversation_participants
ADD COLUMN role text CHECK (role IN ('owner', 'admin', 'member')) NOT NULL DEFAULT 'member';

-- 2. Add group settings to conversations
ALTER TABLE conversations
ADD COLUMN only_admins_send boolean NOT NULL DEFAULT false,
ADD COLUMN only_admins_edit_info boolean NOT NULL DEFAULT false;

-- 3. Add 'voice' to message_type constraint + duration column for voice messages
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_message_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_message_type_check
  CHECK (message_type IN ('text', 'image', 'file', 'audio', 'video', 'voice', 'deleted'));

ALTER TABLE messages
ADD COLUMN duration integer; -- voice message duration in seconds

-- 4. Set existing group creators as 'owner'
UPDATE conversation_participants cp
SET role = 'owner'
FROM conversations c
WHERE cp.conversation_id = c.id
  AND cp.user_id = c.created_by
  AND c.type = 'group';

-- 5. Index for role lookups
CREATE INDEX idx_conv_participants_role ON conversation_participants(conversation_id, role);
