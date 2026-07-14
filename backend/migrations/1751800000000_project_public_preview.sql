-- Public preview links: an author toggles this on to share a stable
-- unauthenticated URL for their project's preview. Toggling off
-- invalidates the URL until re-enabled; the token itself is
-- preserved across on/off cycles so the shared link keeps working
-- when re-enabled without a re-share round trip.

-- Up Migration
ALTER TABLE projects ADD COLUMN IF NOT EXISTS public_preview_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS public_preview_token VARCHAR(64);

-- Unique + indexed: the token is the sole lookup key for anonymous
-- preview requests. NULL is allowed (a project that has never had
-- public preview enabled) and does not participate in the unique
-- constraint under Postgres semantics.
CREATE UNIQUE INDEX IF NOT EXISTS projects_public_preview_token_key
  ON projects (public_preview_token)
  WHERE public_preview_token IS NOT NULL;

-- Down Migration
-- DROP INDEX IF EXISTS projects_public_preview_token_key;
-- ALTER TABLE projects DROP COLUMN IF EXISTS public_preview_token;
-- ALTER TABLE projects DROP COLUMN IF EXISTS public_preview_enabled;
