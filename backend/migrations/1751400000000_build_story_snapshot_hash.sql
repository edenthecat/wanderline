-- content-hash dedup for build enqueue.
--
-- story_snapshot_hash is the SHA-256 of the canonical JSON serialisation
-- of the story graph at build-completion time — the same story
-- (identical nodes, choices, audio references) always hashes to the
-- same value regardless of insertion order or whitespace. The build
-- service persists it alongside the artifact, and the enqueue path
-- looks it up before creating a new row: if the incoming project's
-- current story graph hashes to a recent successful build's stored
-- hash, we return that build instead of running the pipeline again.
--
-- Why not use story_snapshot (the JSONB blob) directly? Hashing at
-- enqueue is one indexable comparison against a 64-char string vs a
-- multi-KB deep-equal on JSONB. The hash is also small enough to
-- keep in RAM if we ever move the lookup off the DB.
--
-- Partial index on (project_id, story_snapshot_hash) restricted to
-- completed non-deleted rows keeps the dedup lookup O(recent builds
-- for this project) and never returns a queued/failed/soft-deleted
-- match.

-- Up Migration

ALTER TABLE project_builds
  ADD COLUMN IF NOT EXISTS story_snapshot_hash VARCHAR(64);

-- DROP + recreate so a dev env that already ran an earlier draft
-- of this migration (without the story_snapshot_hash IS NOT NULL
-- predicate) picks up the tighter form on re-run.
DROP INDEX IF EXISTS idx_project_builds_dedup;

-- Partial index scoped to rows the dedup lookup can actually match:
-- completed, non-deleted, with a non-null hash. Legacy pre-migration
-- completed rows carry NULL and can't match `story_snapshot_hash = $2`
-- anyway (SQL NULL = anything is false), so excluding them keeps the
-- index smaller and its cache footprint tighter over time.
CREATE INDEX IF NOT EXISTS idx_project_builds_dedup
  ON project_builds(project_id, story_snapshot_hash, completed_at DESC)
  WHERE status = 'completed'
    AND deleted_at IS NULL
    AND story_snapshot_hash IS NOT NULL;

-- Down Migration

-- DROP INDEX IF EXISTS idx_project_builds_dedup;
-- ALTER TABLE project_builds DROP COLUMN IF EXISTS story_snapshot_hash;
