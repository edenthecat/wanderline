-- Old takes whose deletion had to wait for a build.
--
-- Uploading a new take over a file deletes the old one from storage, but
-- not while one of the project's builds is running: the build copies
-- audio by the filenames it has already assembled, and pulling an object
-- out from under it would ship a build missing that clip. Those deletions
-- are recorded here and carried out once the project has no build in
-- progress (when a build ends, and on startup), so nothing is left in
-- storage with no row pointing at it.

-- Up Migration
CREATE TABLE IF NOT EXISTS deferred_audio_deletions (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, filename)
);

-- Down Migration
-- DROP TABLE IF EXISTS deferred_audio_deletions;
