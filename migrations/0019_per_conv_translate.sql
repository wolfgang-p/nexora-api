-- 0019_per_conv_translate.sql
-- Per-conversation override for the user-level auto-translate setting.
-- 'on'   → translate even if user setting is off (rare)
-- 'off'  → do not translate even if user setting is on (e.g. learning the
--          language; user wants to read originals in this specific chat)
-- NULL   → fall back to user setting (default).

ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS auto_translate_override TEXT
    CHECK (auto_translate_override IN ('on', 'off') OR auto_translate_override IS NULL);
