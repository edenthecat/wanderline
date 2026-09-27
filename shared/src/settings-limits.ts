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
