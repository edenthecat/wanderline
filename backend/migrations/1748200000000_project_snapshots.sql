-- Version history: per-project snapshots of the story data so a
-- user can roll back from a destructive edit (bulk delete, bad
-- ink upload, or a runaway collaborator). Captures only the parts
-- a user authored — story_graph nodes + ink source + per-node
-- metadata overrides. Audio files and project settings are NOT
-- snapshotted in v1 because (a) audio binaries are large and
-- already orphan-tracked, (b) settings are global and rarely
-- destructively edited. Future iterations can broaden the
-- snapshot envelope.

-- Up Migration

CREATE TABLE IF NOT EXISTS project_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- created_by may be NULL when the snapshot was auto-created by
    -- a background job; user-initiated snapshots always set it.
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    label TEXT NOT NULL,
    -- 'manual' (user pressed "Save snapshot") or 'auto' (created
    -- before a destructive operation: ink reupload, bulk delete,
    -- restore). The UI groups by source.
    source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'auto')),
    story_graph JSONB NOT NULL,
    ink_source TEXT,
    -- Snapshot of node_metadata rows for the project at capture
    -- time, keyed by node_id → metadata fields. Stored inline so
    -- a restore is a single transaction (no joins to a deleted
    -- metadata row).
    node_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_snapshots_project_id
    ON project_snapshots(project_id, created_at DESC);

-- Down Migration

-- DROP TABLE IF EXISTS project_snapshots;
