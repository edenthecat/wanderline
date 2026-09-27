/**
 * Value limits for project settings that more than one package needs to
 * agree on. Defined once here rather than as a matching magic number in
 * each consumer, so a future change can't update one copy and silently
 * leave the others behind.
 */

/**
 * The largest delay `setTimeout` can represent (a signed 32-bit
 * millisecond count). A delay past this clamps to fire almost
 * immediately instead of waiting longer, so it is the real ceiling on
 * `choiceAudioDelayMs` — the silence before a choice option's audio
 * starts — everywhere the value is read: the settings endpoint (which
 * enforces it on every write), the editor (which displays a legacy
 * value that predates the guard), and the player (which drives the
 * pause through `setTimeout` and would otherwise silently erase it for
 * such a value instead of lengthening it).
 */
export const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Apply the choiceAudioDelayMs rule to a raw value: a finite number is
 * held to [0, MAX_SET_TIMEOUT_DELAY_MS]; anything else (missing,
 * non-numeric, NaN) becomes `fallback`.
 *
 * One function rather than three copies of the same ternary, because
 * each of its three callers needs it for the same reason but wants a
 * different fallback: the settings endpoint passes `undefined` to drop
 * an invalid value from a patch entirely, while the editor and the
 * player both pass the 3-second default they fall back to display or
 * play. `MAX_SET_TIMEOUT_DELAY_MS` moved here first for exactly this
 * risk — a rule with three independent copies can have one updated (as
 * this one was, to add the floor and the non-numeric case) while the
 * others silently keep the old behavior.
 */
export function sanitizeChoiceAudioDelayMs<F>(value: unknown, fallback: F): number | F {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(0, value), MAX_SET_TIMEOUT_DELAY_MS)
    : fallback;
}
