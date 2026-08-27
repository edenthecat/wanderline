-- "Mark as fine" for the audio-assignment audit.
--
-- The audit reports clips whose filename resolves to a different node
-- than the one they're attached to. Plenty of those are deliberate —
-- an author assigned a clip by hand, or named a file in a way the
-- matcher was never meant to read — and a report that keeps raising
-- the same known-good rows stops being read at all.
--
-- Acknowledgements are keyed on the SPECIFIC assignment, not just the
-- file. "This clip belongs on this node whatever its name says" stops
-- being true the moment the clip moves, so moving it re-raises the row
-- rather than carrying a stale approval forward.

-- Up Migration
CREATE TABLE IF NOT EXISTS audio_assignment_audit_acks (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    audio_file_id UUID NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    node_id VARCHAR(255) NOT NULL,
    audio_type VARCHAR(32) NOT NULL,
    acked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, audio_file_id, node_id, audio_type)
);

-- The audit reads every ack for a project in one go to filter its
-- report, so the project prefix of the primary key already serves it.
-- No secondary index.

-- Down Migration
-- DROP TABLE IF EXISTS audio_assignment_audit_acks;
