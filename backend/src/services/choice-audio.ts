/**
 * A choice's own audio cue, addressed by the choice's stable id
 * (DEV-199 stable-id rollout) rather than its ordinal position.
 * Encoded directly into `node_audio_assignments.audio_type` as
 * `choice:<id>` rather than a separate column, so every existing
 * audio_type-keyed query (locks, ON CONFLICT targets, DELETE
 * scoping) in routes/audio.ts keeps working unchanged — none of
 * them care that this particular string happens to have a colon in
 * it. Coexists with the older 'choice1'/'choice2' ordinal slots;
 * neither replaces the other, and a choice with no id (data from
 * before the rollout) can only ever use the ordinal ones.
 *
 * Shared between routes/audio.ts (reads/writes the rows) and
 * story-data-builder.ts (turns them into the player manifest) — both
 * must agree on the exact same encoding, so it lives in neither.
 */
const CHOICE_AUDIO_PREFIX = 'choice:';

export function isChoiceAudioType(audioType: string): boolean {
  return audioType.startsWith(CHOICE_AUDIO_PREFIX);
}

export function choiceIdFromAudioType(audioType: string): string {
  return audioType.slice(CHOICE_AUDIO_PREFIX.length);
}

export function audioTypeForChoice(choiceId: string): string {
  return CHOICE_AUDIO_PREFIX + choiceId;
}

const FIXED_AUDIO_TYPES = new Set(['voiceover', 'ambience', 'sfx', 'choice1', 'choice2']);

/** Every audioType routes/audio.ts accepts: the five fixed slots, or
 * `choice:<id>`. One shared check so POST /assignments and bulk-
 * reassign's validation can't silently drift apart from each other.
 * Takes `unknown`, not `string` — found in review: both call sites
 * only checked the request body's `audioType` for truthiness before
 * calling this, so a non-string value (`1`, `{}`) reached
 * `.startsWith` below and THREW, turning a malformed request into a
 * 500 instead of the intended 400 validation response. */
export function isValidAudioType(audioType: unknown): audioType is string {
  return (
    typeof audioType === 'string' &&
    (FIXED_AUDIO_TYPES.has(audioType) || isChoiceAudioType(audioType))
  );
}
