-- User settings table
CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Privacy (Datenschutz)
  show_online_status BOOLEAN DEFAULT true,
  show_last_seen BOOLEAN DEFAULT true,
  show_read_receipts BOOLEAN DEFAULT true,
  show_profile_photo TEXT DEFAULT 'everyone' CHECK (show_profile_photo IN ('everyone', 'contacts', 'nobody')),

  -- Notifications (Benachrichtigungen)
  push_notifications BOOLEAN DEFAULT true,
  message_sound BOOLEAN DEFAULT true,
  group_notifications BOOLEAN DEFAULT true,
  show_preview BOOLEAN DEFAULT true,

  -- Appearance (Darstellung)
  theme TEXT DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  font_size TEXT DEFAULT 'medium' CHECK (font_size IN ('small', 'medium', 'large')),
  chat_bubble_style TEXT DEFAULT 'modern' CHECK (chat_bubble_style IN ('modern', 'classic', 'minimal')),

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
