-- Reminders: "ping me about this later".
-- Optionally attached to a task, a message, or standalone text.
CREATE TABLE IF NOT EXISTS reminders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  body              TEXT,
  remind_at         TIMESTAMPTZ NOT NULL,

  -- Optional anchors so the push can deep-link into the source context.
  task_id           UUID REFERENCES tasks(id)         ON DELETE SET NULL,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id        UUID REFERENCES messages(id)      ON DELETE SET NULL,

  fired_at          TIMESTAMPTZ,
  dismissed_at      TIMESTAMPTZ,
  snoozed_until     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The sweeper scans this index every 30 s to fire due reminders.
CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON reminders (remind_at)
  WHERE fired_at IS NULL AND dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS reminders_user_upcoming_idx
  ON reminders (user_id, remind_at)
  WHERE fired_at IS NULL;

-- Scheduled messages: "send this at 14:00 tomorrow".
-- E2E stays intact: the sender's device seals one ciphertext per recipient
-- device at schedule time. Server never sees plaintext. Trade-off: devices
-- added to the conversation BETWEEN schedule and send will not receive a
-- copy (ciphertexts were sealed to the device set as of schedule time).
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id       UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  sender_device_id     UUID NOT NULL REFERENCES devices(id)       ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  send_at              TIMESTAMPTZ NOT NULL,
  kind                 TEXT NOT NULL DEFAULT 'text',
  -- JSON array: [{device_id, ciphertext, nonce}]
  recipients           JSONB NOT NULL,
  reply_to_message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,

  sent_at              TIMESTAMPTZ,
  sent_message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  canceled_at          TIMESTAMPTZ,
  last_error           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx
  ON scheduled_messages (send_at)
  WHERE sent_at IS NULL AND canceled_at IS NULL;

CREATE INDEX IF NOT EXISTS scheduled_messages_user_idx
  ON scheduled_messages (sender_user_id, send_at DESC)
  WHERE sent_at IS NULL AND canceled_at IS NULL;
