// Variable-conditioned audio: a slot (voiceover/ambience/choice1/
// choice2) can carry several candidate files instead of one, each
// gated by an optional {variable, operator, value} condition. The
// manifest (collectNodeAudio, backend/src/services/story-data-
// builder.ts) always orders conditioned candidates before the one
// unconditioned/default candidate, so resolveAudioVariant just needs
// to scan linearly and return the first match.

import {
  evaluateSimpleCondition,
  type SimpleCondition,
  type VariableValue,
} from '@wanderline/shared';

export interface AudioVariant {
  file: string;
  condition?: SimpleCondition;
}

/**
 * Pick which candidate actually plays, given live variable state.
 * Returns undefined when the slot has no candidates, or every
 * conditioned candidate fails and there's no unconditioned fallback —
 * same "stay silent, don't crash" posture conditionAllows already
 * uses for Choice/TextBlock conditions.
 */
export function resolveAudioVariant(
  variants: AudioVariant[] | undefined,
  variables: Record<string, VariableValue>,
): string | undefined {
  for (const variant of variants ?? []) {
    if (!variant.condition || evaluateSimpleCondition(variant.condition, variables)) {
      return variant.file;
    }
  }
  return undefined;
}

/**
 * Every candidate file for a slot, regardless of which one will
 * actually be chosen. Used for preloading: at preload time (e.g. for
 * the node the player is about to navigate to) the variable state as
 * of ARRIVAL isn't necessarily known yet, so v1 preloads every
 * candidate rather than guessing — slightly wasteful, never wrong.
 */
export function allAudioVariantFiles(variants: AudioVariant[] | undefined): string[] {
  return (variants ?? []).map((v) => v.file);
}
