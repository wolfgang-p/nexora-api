-- dev_hard_reset_supabase.sql
-- ──────────────────────────────────────────────────────────────────────
-- ⚠️  DESTROYS ALL APPLICATION DATA. NEVER RUN AGAINST PROD.
--
-- Reine-SQL-Variante für den Supabase SQL Editor (keine psql-Meta-
-- Befehle). Löscht jede Zeile in jeder Koro-Tabelle und lässt Schema,
-- Indexes, Enums, RLS unangetastet.
--
-- Benutzung:
--   1. Paste diesen Block in den SQL Editor.
--   2. Run → fertig.
--
-- Schutz: Die Guard-Anweisung unten verhindert ein versehentliches
-- Ausführen. Zum wirklich-Ausführen die markierte Zeile aktivieren.
-- ──────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Safety gate ─────────────────────────────────────────────────────
-- Setze die folgende Variable auf 'yes', um den Reset zu entsperren.
-- Solange sie anders steht, bricht das Skript mit Fehler ab.
SET LOCAL koro.reset_confirm = 'no';  -- ← auf 'yes' setzen zum Ausführen

DO $$
BEGIN
  IF current_setting('koro.reset_confirm', true) <> 'yes' THEN
    RAISE EXCEPTION
      'Hard-reset abgebrochen. Setze "SET LOCAL koro.reset_confirm = ''yes'';" ganz oben, um auszuführen.';
  END IF;
END $$;

-- ── Truncate everything ─────────────────────────────────────────────
-- FKs werden per CASCADE aufgelöst; RESTART IDENTITY setzt Sequenzen
-- zurück (gen_random_uuid() braucht das nicht, schadet aber nicht).
TRUNCATE TABLE
  -- identity & auth
  users,
  otps,
  devices,
  pairing_sessions,
  sessions,
  push_tokens,
  user_settings,
  banned_fingerprints,
  blocks,
  user_blocks,
  -- workspaces
  workspaces,
  workspace_members,
  workspace_invites,
  workspace_files,
  -- conversations & messages
  conversations,
  conversation_members,
  messages,
  message_recipients,
  message_reactions,
  thread_reads,
  scheduled_messages,
  -- media
  media_objects,
  media_recipients,
  -- calls
  calls,
  call_participants,
  -- tasks & reminders
  task_lists,
  tasks,
  task_checklist_items,
  reminders,
  -- polls
  polls,
  poll_options,
  poll_votes,
  -- stories
  stories,
  story_recipients,
  story_views,
  story_reactions,
  -- moderation & admin
  reports,
  report_appeals,
  feedback,
  feature_flags,
  retention_policies,
  audit_events,
  spam_signatures,
  -- integrations
  api_keys,
  webhooks,
  webhook_deliveries,
  webhook_event_log
RESTART IDENTITY CASCADE;

-- ── Sanity check ────────────────────────────────────────────────────
-- Läuft über alle public.*-Tabellen und warnt, falls irgendwo noch
-- Zeilen stehen (z. B. neue Tabellen nach Migration 0013).
DO $$
DECLARE
  t RECORD;
  n BIGINT;
  bad INT := 0;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE 'pg_%'
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I', t.tablename) INTO n;
    IF n <> 0 THEN
      RAISE WARNING 'Tabelle % hat noch % Zeilen', t.tablename, n;
      bad := bad + 1;
    END IF;
  END LOOP;
  IF bad = 0 THEN
    RAISE NOTICE 'Hard-reset komplett: jede public.*-Tabelle ist leer.';
  ELSE
    RAISE WARNING '% Tabelle(n) enthalten noch Daten — wahrscheinlich neue Tabellen nach 0013. Füge sie zum Reset-Skript hinzu.', bad;
  END IF;
END $$;

COMMIT;
