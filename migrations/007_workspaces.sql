-- workspaces
CREATE TABLE workspaces (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    description text,
    avatar_url text,
    owner_id uuid REFERENCES users(id) NOT NULL,
    join_code text UNIQUE,
    created_at timestamp with time zone DEFAULT now()
);

-- workspace_members
CREATE TABLE workspace_members (
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    role text CHECK (role IN ('owner', 'admin', 'member', 'guest')) DEFAULT 'member',
    permissions jsonb DEFAULT '{}'::jsonb, -- Custom permission overrides (e.g., {"can_manage_channels": true, "can_upload_files": false})
    joined_at timestamp with time zone DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

-- workspace_invites
CREATE TABLE workspace_invites (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    inviter_id uuid REFERENCES users(id) ON DELETE CASCADE,
    invitee_id uuid REFERENCES users(id) ON DELETE CASCADE, -- specific user invite
    status text CHECK (status IN ('pending', 'accepted', 'rejected')) DEFAULT 'pending',
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone
);

-- workspace_channels
CREATE TABLE workspace_channels (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    type text CHECK (type IN ('text', 'voice', 'announcement')) DEFAULT 'text',
    is_private boolean DEFAULT false,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- workspace_channel_members (for private channels)
CREATE TABLE workspace_channel_members (
    channel_id uuid REFERENCES workspace_channels(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    role text DEFAULT 'member',
    joined_at timestamp with time zone DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

-- workspace_messages
CREATE TABLE workspace_messages (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    channel_id uuid REFERENCES workspace_channels(id) ON DELETE CASCADE,
    sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
    encrypted_content text, -- Keeping name consistent, works for unencrypted too
    message_type text CHECK (message_type IN ('text', 'image', 'file', 'audio', 'system')) NOT NULL DEFAULT 'text',
    media_url text,
    file_name text,
    file_size integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone
);

-- workspace files view (helper table/view or just relying on workspace_messages where message_type IN ('file', 'image', 'audio'))
-- Since they requested "Eigene Dateien ansicht" (Own files view).
-- Files are essentially tied to messages, or could be independent workspace_files

CREATE TABLE workspace_files (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    uploader_id uuid REFERENCES users(id) ON DELETE SET NULL,
    channel_id uuid REFERENCES workspace_channels(id) ON DELETE CASCADE, -- Channel where it was shared
    message_id uuid REFERENCES workspace_messages(id) ON DELETE CASCADE, -- Message it belongs to
    file_name text NOT NULL,
    file_size integer NOT NULL,
    media_url text NOT NULL,
    message_type text, -- 'image' or 'file'
    created_at timestamp with time zone DEFAULT now()
);
