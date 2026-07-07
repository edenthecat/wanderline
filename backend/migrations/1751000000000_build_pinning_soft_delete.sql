-- pinning + soft-delete groundwork for build retention.
--
-- Two columns on project_builds:
--   pinned      — user-marked builds skipped by the automatic MAX_BUILDS_PER_PROJECT
--                 retention. Currently retention is enforced at enqueue (the cap
--                 rejects the 6th build) rather than by auto-culling, but this
--                 lays the groundwork for the retention job that comes
--   deleted_at  — soft-delete timestamp. DELETE /builds/:id now sets this instead
--                 of hard-deleting the row + purging the artifact synchronously.
--                 A reconciliation sweep (reconcileSoftDeletedBuilds) runs at
--                 server startup alongside cleanupStaleBuilds and hard-deletes
--                 rows whose deleted_at is > 24h old, giving accidental deletes
--                 a recovery window.
--
-- The partial index makes the "active build" queries (list, cap check,
-- active-build check) O(active builds) instead of O(all builds ever).
-- next-number allocation is deliberately NOT covered by this index —
-- MAX(build_number) still scans across soft-deleted rows so build
-- numbers don't get reused while a soft-deleted row still exists.

-- Up Migration

ALTER TABLE project_builds
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_project_builds_active
  ON project_builds(project_id, build_number DESC)
  WHERE deleted_at IS NULL;

-- Down Migration

-- DROP INDEX IF EXISTS idx_project_builds_active;
-- ALTER TABLE project_builds DROP COLUMN IF EXISTS deleted_at;
-- ALTER TABLE project_builds DROP COLUMN IF EXISTS pinned;
