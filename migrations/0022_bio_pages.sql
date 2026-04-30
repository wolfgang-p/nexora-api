-- 0022_bio_pages.sql
-- koro.bio: per-user public LinkTree-style page.
--
-- Each user gets at most ONE bio_pages row, identified by user_id, served
-- publicly at koro.bio/<username>. Theme is a small JSONB blob with
-- gradient colours, font, layout — no schema enforcement, the renderer
-- ignores keys it doesn't know.
--
-- Links are ordered child rows. `kind` is either a known platform slug
-- (instagram/facebook/x/tiktok/...) or 'custom'. For 'custom' the client
-- supplies the URL; for known platforms we still store a full URL so the
-- public page never has to look up handle prefixes.
--
-- enabled = soft-hide a single link without deleting it.
-- published = bio page is publicly resolvable. Off by default so a user
-- can prep their page before flipping the switch.

CREATE TABLE IF NOT EXISTS bio_pages (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  published    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Free-form display name override; falls back to users.display_name when null.
  display_name TEXT,
  bio          TEXT,
  -- JSONB: { template, gradient_from, gradient_to, gradient_angle,
  --         text_color, button_style, font, background_url, ... }
  theme        JSONB NOT NULL DEFAULT '{}'::jsonb,
  view_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bio_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Platform slug ('instagram', 'tiktok', 'website', 'custom', ...).
  -- Renderer maps slug -> brand colour + icon.
  kind          TEXT NOT NULL DEFAULT 'custom',
  title         TEXT NOT NULL,
  url           TEXT NOT NULL,
  -- Optional override of the auto-fetched favicon (uploaded to media).
  icon_url      TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  click_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bio_links_user_pos ON bio_links (user_id, position);
CREATE INDEX IF NOT EXISTS bio_links_user_enabled ON bio_links (user_id) WHERE enabled = TRUE;
