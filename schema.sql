-- users
CREATE TABLE users (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    phone_number text UNIQUE NOT NULL,
    display_name text,
    username text UNIQUE,
    account_type text CHECK (account_type IN ('personal', 'business')),
    avatar_url text,
    public_key text,
    is_online boolean DEFAULT false,
    last_seen timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now()
);

-- otps
CREATE TABLE otps (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    phone_number text NOT NULL,
    otp_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used boolean DEFAULT false
);

-- conversations
CREATE TABLE conversations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    type text CHECK (type IN ('direct', 'group')) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    created_by uuid REFERENCES users(id)
);

-- conversation_participants
CREATE TABLE conversation_participants (
    conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    joined_at timestamp with time zone DEFAULT now(),
    last_read_message_id uuid,
    PRIMARY KEY (conversation_id, user_id)
);

-- messages
CREATE TABLE messages (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id uuid REFERENCES users(id),
    encrypted_content text,
    message_type text CHECK (message_type IN ('text', 'image', 'file', 'audio')) NOT NULL DEFAULT 'text',
    media_url text,
    created_at timestamp with time zone DEFAULT now(),
    delivered_at timestamp with time zone,
    read_at timestamp with time zone
);

ALTER TABLE conversation_participants
ADD CONSTRAINT fk_last_read_message FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE SET NULL;
