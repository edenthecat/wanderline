-- Per-choice audio, addressed by the choice's own stable id.
--
-- Until now a choice cue could only be attached to the FIRST or
-- SECOND choice on a node (audio_type = 'choice1' / 'choice2',
-- ordinal — misattributes silently if choices are reordered). This
-- relaxes the audio_type CHECK to also allow 'choice:<id>', where
-- <id> is the choice's own stable id (DEV-199 stable-id rollout),
-- so any number of choices can each have their own cue, keyed by
-- identity rather than position.
--
-- Deliberately NOT a new column: audio_type was already an opaque
-- string key everywhere it's used (locks, ON CONFLICT targets,
-- DELETE scoping) — encoding the choice id INTO that same string
-- means every one of those call sites keeps working unchanged. A
-- separate choice_id column would need its own widened unique
-- constraint and a third branch in every conflict-target decision
-- that `condition` already made two-way; this needs none of that.
--
-- choice1/choice2 rows are untouched — both addressing schemes
-- coexist; nothing migrates existing data. VARCHAR(50) already fits
-- 'choice:' (7) + a UUID (36) = 43 chars with room to spare.

-- Up Migration
ALTER TABLE node_audio_assignments
    DROP CONSTRAINT IF EXISTS node_audio_assignments_audio_type_check;

ALTER TABLE node_audio_assignments
    ADD CONSTRAINT node_audio_assignments_audio_type_check
    CHECK (
        audio_type IN ('voiceover', 'ambience', 'sfx', 'choice1', 'choice2')
        OR audio_type LIKE 'choice:%'
    );

-- Down Migration
-- ALTER TABLE node_audio_assignments DROP CONSTRAINT IF EXISTS node_audio_assignments_audio_type_check;
-- ALTER TABLE node_audio_assignments ADD CONSTRAINT node_audio_assignments_audio_type_check CHECK (audio_type IN ('voiceover', 'ambience', 'sfx', 'choice1', 'choice2'));
