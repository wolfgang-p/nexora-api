-- 0016_auto_translate.sql
-- Per-user auto-translate preferences. When enabled, the mobile/web
-- client calls /ai/translate on every incoming message in a foreign
-- language and renders the translation by default; the user can tap
-- a small badge to flip back to the original.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS auto_translate_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_translate_target  TEXT,
  ADD COLUMN IF NOT EXISTS auto_translate_show_original BOOLEAN NOT NULL DEFAULT TRUE;
