-- Widen audio_assignment_audit_acks.audio_type to match
-- node_audio_assignments.audio_type (VARCHAR(50)) now that
-- audio_type can be 'choice:<id>' — 'choice:' (7) + a randomUUID()
-- (36) = 43 characters, which the old VARCHAR(32) can't hold.
-- Acknowledging an audit row for a choice:<id> assignment would
-- otherwise 500 on insert (Postgres 22001, value too long).

-- Up Migration
ALTER TABLE audio_assignment_audit_acks
    ALTER COLUMN audio_type TYPE VARCHAR(50);

-- Down Migration
-- ALTER TABLE audio_assignment_audit_acks ALTER COLUMN audio_type TYPE VARCHAR(32);
