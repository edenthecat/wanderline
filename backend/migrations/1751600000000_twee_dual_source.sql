-- dual-source storage for Twine/Twee imports.
--
-- source_language records whether the project is authored in Ink or
-- Twee. Set exclusively by uploads: POST /projects/:id/ink (→ 'ink'),
-- POST /projects/:id/ink-json (→ 'ink'), POST /projects/:id/twine
-- (→ 'twee'). There is no in-app toggle — adds a per-project
-- *nomenclature* preference (project_settings.nomenclature) that
-- overrides the vocab shown in the UI, not the underlying format.
--
-- twee_source is the symmetric counterpart to ink_source. Whichever
-- of the two matches source_language is the authoritative text; the
-- other is either NULL (never regenerated) or a cached emit-from-
-- graph result (Phase 2 wires the cache).
--
-- Existing rows default to 'ink' so earlier projects behave
-- unchanged. `twee_source` starts NULL for every row.

-- Up Migration

ALTER TABLE project_stories
  ADD COLUMN IF NOT EXISTS source_language TEXT NOT NULL DEFAULT 'ink'
    CHECK (source_language IN ('ink', 'twee')),
  ADD COLUMN IF NOT EXISTS twee_source TEXT;

-- Down Migration

-- ALTER TABLE project_stories DROP COLUMN IF EXISTS twee_source;
-- ALTER TABLE project_stories DROP COLUMN IF EXISTS source_language;
