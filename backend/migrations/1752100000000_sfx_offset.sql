-- When a node's sound effect plays.
--
-- SFX could always be assigned to a node, but nothing past the editor
-- ever read them, so there was never a question of WHEN they play.
-- Now the player fires them: with no offset, as the passage starts;
-- with one, that many milliseconds into the narration (or after
-- arriving, on a passage with no narration), so a door can slam on
-- the right word.
--
-- Nullable rather than defaulting to 0 so "the author never set one"
-- stays distinguishable from "the author chose the very start". Only
-- meaningful on sfx rows; the other slot types ignore it.

-- Up Migration
ALTER TABLE node_audio_assignments
    ADD COLUMN IF NOT EXISTS offset_ms INTEGER
    CHECK (offset_ms IS NULL OR offset_ms >= 0);

-- Down Migration
-- ALTER TABLE node_audio_assignments DROP COLUMN IF EXISTS offset_ms;
