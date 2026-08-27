-- Flagging a passage from the preview.
--
-- Reviewing a story means listening to it, and the moment you notice
-- something wrong is while it's playing — not later, back in the
-- editor, trying to remember which passage it was. Flags are raised
-- from the preview and surface on the passage itself in both the story
-- list and the graph.
--
-- Not resolved by deletion: a flag that was raised and dealt with is
-- useful history when the same passage is questioned again. resolved_at
-- doubles as the open/closed discriminator.

-- Up Migration
CREATE TABLE IF NOT EXISTS node_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Deliberately not a foreign key: node ids live inside the story
    -- graph JSONB, and a flag on a passage that was renamed or deleted
    -- is exactly the kind of thing a reviewer needs to still see.
    node_id VARCHAR(255) NOT NULL,
    reason VARCHAR(32) NOT NULL,
    note TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- The editor asks "which passages have open flags?" on every story and
-- graph render, so that lookup gets the index; resolved rows are
-- excluded from it since they're only read on demand.
CREATE INDEX IF NOT EXISTS node_flags_open_by_project
    ON node_flags (project_id, node_id)
    WHERE resolved_at IS NULL;

-- Down Migration
-- DROP INDEX IF EXISTS node_flags_open_by_project;
-- DROP TABLE IF EXISTS node_flags;
