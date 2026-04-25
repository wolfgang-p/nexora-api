-- dev_hard_reset.sql
-- ──────────────────────────────────────────────────────────────────────
-- ⚠️  DESTROYS ALL APPLICATION DATA.  NEVER RUN AGAINST PROD.
--
-- Truncates every Koro-owned table in the public schema while
-- preserving the schema itself (tables, columns, types, sequences,
-- indexes, FKs, RLS). After this script runs the DB looks like it
-- did the moment after the last migration — zero rows everywhere.
--
-- FKs are honoured via TRUNCATE … CASCADE in a single statement so
-- ordering doesn't matter and we never fail on mutual refs.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/dev_hard_reset.sql
--
-- The guard below refuses to run unless the caller opts in explicitly:
--   psql "$DATABASE_URL" -v koro_reset_confirm=yes \
--     -f migrations/dev_hard_reset.sql
-- ──────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

-- Safety gate: requires `-v koro_reset_confirm=yes` on the CLI.
\if :{?koro_reset_confirm}
  \if :koro_reset_confirm
    \echo '→ hard-reset confirmed, proceeding.'
  \else
    \echo 'ABORT: set -v koro_reset_confirm=yes to proceed.'
    \q
  \endif
\else
  \echo 'ABORT: set -v koro_reset_confirm=yes to proceed.'
  \q
\endif

BEGIN;

-- ── Identity & auth ──────────────────────────────────────────────
-- Listed for visibility; TRUNCATE CASCADE below handles everything
-- in a single statement regardless of order.
--
--   users                   otps
--   devices                 pairing_sessions
--   sessions                push_tokens
--   user_settings           banned_fingerprints
--   blocks (legacy)         user_blocks
--
-- ── Workspaces ──────────────────────────────────────────────────
--   workspaces              workspace_members
--   workspace_invites       workspace_files
--
-- ── Conversations & messages ────────────────────────────────────
--   conversations           conversation_members
--   messages                message_recipients
--   message_reactions       thread_reads
--   scheduled_messages
--
-- ── Media ───────────────────────────────────────────────────────
--   media_objects           media_recipients
--
-- ── Calls ───────────────────────────────────────────────────────
--   calls                   call_participants
--
-- ── Tasks & reminders ───────────────────────────────────────────
--   task_lists              tasks
--   task_checklist_items    reminders
--
-- ── Polls ───────────────────────────────────────────────────────
--   polls                   poll_options            poll_votes
--
-- ── Stories ─────────────────────────────────────────────────────
--   stories                 story_recipients
--   story_views             story_reactions
--
-- ── Moderation & admin ──────────────────────────────────────────
--   reports                 report_appeals
--   feedback                feature_flags
--   retention_policies      audit_events
--   spam_signatures
--
-- ── Integrations ────────────────────────────────────────────────
--   api_keys                webhooks
--   webhook_deliveries      webhook_event_log

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

-- Sanity: every table should now be 0 rows. Report anything non-zero.
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
      RAISE WARNING 'table % still has % rows', t.tablename, n;
      bad := bad + 1;
    END IF;
  END LOOP;
  IF bad = 0 THEN
    RAISE NOTICE 'hard-reset complete: every public.* table is empty.';
  ELSE
    RAISE WARNING '% table(s) still contain data — check if they were added after migration 0013.', bad;
  END IF;
END $$;

COMMIT;
