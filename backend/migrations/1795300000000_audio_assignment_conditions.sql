-- Variable-conditioned audio.
--
-- Until now a slot (voiceover/ambience/choice1/choice2/each sfx file)
-- held at most one assignment per node, enforced in application code
-- (routes/audio.ts clears the existing row before inserting a new
-- one). This lets a slot hold SEVERAL candidate files instead, each
-- tagged with an optional condition — a simple {variable, operator,
-- value} triple the player evaluates against live story-variable
-- state at node-entry, picking the first match and falling back to
-- the one untagged (condition IS NULL) row for that slot, if any.
--
-- Still enforced in application code, not here: at most one NULL-
-- condition row and at most one row per distinct condition, per
-- (node_id, audio_type) — same place the single-row invariant was
-- already enforced before this migration, just widened.
--
-- The old 4-column uniqueness (project_id, node_id, audio_type,
-- audio_file_id) would block the SAME file being assigned twice
-- under two DIFFERENT conditions, which is a legitimate case (e.g.
-- reusing one ambience bed for two different conditions) — widen it
-- to include `condition` so only an exact (file, condition) repeat
-- collides.

-- Up Migration
ALTER TABLE node_audio_assignments
    ADD COLUMN IF NOT EXISTS condition JSONB;

-- Find the original 4-column UNIQUE constraint by the set of columns
-- it covers, not by its (auto-generated, possibly name-length-
-- truncated) name — safer than guessing what Postgres called it.
DO $$
DECLARE
    old_constraint_name text;
BEGIN
    SELECT con.conname INTO old_constraint_name
    FROM pg_constraint con
    WHERE con.conrelid = 'node_audio_assignments'::regclass
      AND con.contype = 'u'
      AND (
          SELECT array_agg(attname ORDER BY attname)
          FROM pg_attribute
          WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)
      ) = ARRAY['audio_file_id', 'audio_type', 'node_id', 'project_id']::name[]
    LIMIT 1;

    IF old_constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE node_audio_assignments DROP CONSTRAINT %I', old_constraint_name);
    END IF;
END $$;

ALTER TABLE node_audio_assignments
    DROP CONSTRAINT IF EXISTS node_audio_assignments_file_condition_unique;

ALTER TABLE node_audio_assignments
    ADD CONSTRAINT node_audio_assignments_file_condition_unique
    UNIQUE (project_id, node_id, audio_type, audio_file_id, condition);

-- A plain UNIQUE constraint treats every NULL as distinct from every
-- other NULL (confirmed empirically, not just by spec-reading) — so
-- the constraint just added does NOT stop two rows with condition IS
-- NULL (the common, default-variant case) from being inserted for the
-- exact same (node, type, file). A partial index, scoped to only the
-- NULL-condition rows, is the actual enforcement for that case; `ON
-- CONFLICT (...) WHERE condition IS NULL` in routes/audio.ts targets
-- this specifically for the insert-paths that don't already clear a
-- matching row before inserting.
CREATE UNIQUE INDEX IF NOT EXISTS node_audio_assignments_default_variant_unique
    ON node_audio_assignments (project_id, node_id, audio_type, audio_file_id)
    WHERE condition IS NULL;

-- Down Migration
-- DROP INDEX IF EXISTS node_audio_assignments_default_variant_unique;
-- ALTER TABLE node_audio_assignments DROP CONSTRAINT IF EXISTS node_audio_assignments_file_condition_unique;
-- ALTER TABLE node_audio_assignments ADD CONSTRAINT node_audio_assignments_project_id_node_id_audio_type_audio_key UNIQUE (project_id, node_id, audio_type, audio_file_id);
-- ALTER TABLE node_audio_assignments DROP COLUMN IF EXISTS condition;
