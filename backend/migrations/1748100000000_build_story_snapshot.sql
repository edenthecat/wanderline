-- per-build preview snapshots
--
-- Each project_builds row gets a denormalised copy of the story data
-- that was rendered into the zip at build time. The per-build preview
-- route reads this column instead of re-parsing the artifact so that:
--   - the preview reflects the build's state, not the current project
--   - we don't have to extract the zip on every preview request
--
-- Audio is still resolved against the current project's audio_files
-- (see /preview/audio handler) so deleted-since-build audio will 404
-- in the preview — acceptable for v1; building/restoring audio out of
-- the zip is a future follow-up.

-- Up Migration

ALTER TABLE project_builds
  ADD COLUMN IF NOT EXISTS story_snapshot JSONB;

-- Down Migration

-- ALTER TABLE project_builds DROP COLUMN IF EXISTS story_snapshot;
