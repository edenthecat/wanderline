-- record which player bundle each project build shipped against.
--
-- Two columns on project_builds:
--   player_bundle_version   — human-readable identifier (e.g. "0.1.0-abc1234").
--                             Comes from player-app/dist/bundle-info.json,
--                             which is emitted by scripts/emit-bundle-info.mjs
--                             at the end of the player-app build.
--   player_bundle_sri_hash  — SHA-384 SRI hash of the main JS bundle, base64
--                             prefixed with "sha384-". Preview shells and the
--                             build zip can embed this as an `integrity`
--                             attribute so a tampered bundle refuses to run.
--
-- Both columns are nullable — projects built before this migration ran
-- won't have them, and dev environments without a bundle-info.json
-- (e.g. an old vite build that predates the post-build step) also
-- can't populate them. The build-service reads best-effort and logs a
-- warn instead of failing when bundle-info is unreadable, so a bad
-- release of the player-app can't wedge the backend build pipeline.

-- Up Migration

ALTER TABLE project_builds
  ADD COLUMN IF NOT EXISTS player_bundle_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS player_bundle_sri_hash VARCHAR(128);

-- Down Migration

-- ALTER TABLE project_builds DROP COLUMN IF EXISTS player_bundle_sri_hash;
-- ALTER TABLE project_builds DROP COLUMN IF EXISTS player_bundle_version;
