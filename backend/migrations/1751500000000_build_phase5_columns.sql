-- Phase 5 completion — idempotency, retention auto-cull hint,
-- attempt-count for retry, cancel status, worker lease groundwork.
--
-- idempotency_key    — client-supplied header value (max 128 chars).
--                      Uniquely scoped per (project_id, created_by).
--                      A same-key retry within the window returns the
--                      existing row instead of enqueuing a new build.
-- attempt_count      — how many times executeBuild has been kicked
--                      off for this row. Bounded at MAX_BUILD_ATTEMPTS
--                      (3) — beyond that we give up and mark 'failed'
--                      rather than looping forever on a wedged input.
-- worker_id          — Cloud Run instance / worker that currently
--                      owns the row. Nullable while the row is queued.
-- leased_until       — expiry of the current worker's claim. Another
--                      worker may take over after this time; today's
--                      in-process executeBuild sets it far into the
--                      future so the sweep doesn't reap live builds.
--
-- Also extends the status CHECK constraint to include 'cancelled' so
-- the cancel endpoint can set a terminal state that isn't 'failed'.

-- Up Migration

ALTER TABLE project_builds
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128),
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worker_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ;

-- Extend the status constraint to allow 'cancelled'. The old CHECK
-- constraint has a synthesized name — pull it off + reapply so tests
-- match the shape a fresh baseline.sql would produce.
ALTER TABLE project_builds DROP CONSTRAINT IF EXISTS project_builds_status_check;
ALTER TABLE project_builds
  ADD CONSTRAINT project_builds_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'));

-- Idempotency lookup scoped per (project, user, key). Scoping to
-- created_by prevents collaborator A from claiming user B's keyed
-- retry — a fresh key means a fresh build for the caller who owns it.
-- The unique constraint enforces at-most-one row per (project, user,
-- key) — the enqueue handler upserts by looking up and returning
-- rather than trying to INSERT and catching a UNIQUE violation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_builds_idempotency
  ON project_builds(project_id, created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Queue scan for future out-of-band worker (Phase 5 slice 2) —
-- keeps the lease-claim SELECT O(open jobs). No-op today because
-- executeBuild runs in-process, but the index lands with the schema
-- so we can toggle the worker on without another migration.
CREATE INDEX IF NOT EXISTS idx_project_builds_queue
  ON project_builds(status, created_at)
  WHERE status IN ('pending', 'processing');

-- Down Migration

-- DROP INDEX IF EXISTS idx_project_builds_queue;
-- DROP INDEX IF EXISTS idx_project_builds_idempotency;
-- ALTER TABLE project_builds DROP CONSTRAINT IF EXISTS project_builds_status_check;
-- ALTER TABLE project_builds
--   ADD CONSTRAINT project_builds_status_check
--   CHECK (status IN ('pending', 'processing', 'completed', 'failed'));
-- ALTER TABLE project_builds DROP COLUMN IF EXISTS leased_until;
-- ALTER TABLE project_builds DROP COLUMN IF EXISTS worker_id;
-- ALTER TABLE project_builds DROP COLUMN IF EXISTS attempt_count;
-- ALTER TABLE project_builds DROP COLUMN IF EXISTS idempotency_key;
