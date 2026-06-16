-- 0027_workspace_wiki_perms.sql
-- Workspaces 2.0 — Wiki/Notes pages + (future) fine-grained member perms.
--
--   • workspace_pages: markdown wiki/notes per workspace, with optional
--     nesting (parent_page_id) and pin. Soft-deleted via deleted_at.
--   • workspace_members.permissions already exists (JSONB) from 0001_core —
--     no schema change; the API just starts reading/writing it.
--
-- Access control follows the rest of the codebase: the service-role client
-- bypasses RLS and every handler enforces membership via requireMember().
-- We still enable RLS + a member-scoped SELECT policy for defense-in-depth,
-- mirroring the workspace tables in 0002_rls_policies.sql.
--
-- All idempotent.

-- ── Wiki / Notes ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',          -- markdown source
  parent_page_id  UUID REFERENCES workspace_pages(id) ON DELETE CASCADE,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  pinned_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- Listing query: pinned first, then most-recently-updated.
CREATE INDEX IF NOT EXISTS workspace_pages_ws_idx
  ON workspace_pages (workspace_id, pinned_at DESC NULLS LAST, updated_at DESC)
  WHERE deleted_at IS NULL;

-- Nesting lookups (sub-pages of a page).
CREATE INDEX IF NOT EXISTS workspace_pages_parent_idx
  ON workspace_pages (workspace_id, parent_page_id, updated_at DESC)
  WHERE deleted_at IS NULL;

-- Full-text-ish search index for the workspace-wide search endpoint
-- (title + body ILIKE). A trigram index keeps `%q%` queries fast.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS workspace_pages_title_trgm_idx
  ON workspace_pages USING gin (title gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- ── RLS (defense-in-depth; service-role bypasses) ───────────────────────────
ALTER TABLE workspace_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_pages_member_select ON workspace_pages;
CREATE POLICY workspace_pages_member_select ON workspace_pages
  FOR SELECT USING (deleted_at IS NULL AND koro.is_ws_member(workspace_id));

DROP POLICY IF EXISTS workspace_pages_member_write ON workspace_pages;
CREATE POLICY workspace_pages_member_write ON workspace_pages
  FOR ALL USING (koro.is_ws_member(workspace_id))
          WITH CHECK (koro.is_ws_member(workspace_id));
