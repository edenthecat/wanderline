// When a passage's sound effects fire.
//
// A sound effect with no offset plays as the passage starts, whether or
// not the narration has (a pre-roll delay or a slow load doesn't hold it
// back). One with an offset, 0 included, plays that far into the
// narration, measured on the voiceover's own clock (so pausing,
// buffering and a stall retry all keep it in step with the words), or
// that long after arriving on a passage that has no narration. One timed past the end of the narration plays when the
// narration ends. Each plays at most once per passage visit.

export interface PassageSfx {
  file: string;
  offsetMs?: number;
}

/** Offset to fire at; an unset, negative or non-finite offset means the start. */
export function sfxOffset(fx: PassageSfx): number {
  const o = fx.offsetMs;
  return typeof o === 'number' && Number.isFinite(o) && o > 0 ? o : 0;
}

/**
 * Indices of the effects due at `elapsedMs` that haven't played yet,
 * marking them played. Pass Infinity to take everything still pending.
 */
export function takeDueSfx(sfx: PassageSfx[], elapsedMs: number, played: Set<number>): number[] {
  const due: number[] = [];
  sfx.forEach((fx, i) => {
    if (!played.has(i) && elapsedMs >= sfxOffset(fx)) {
      played.add(i);
      due.push(i);
    }
  });
  return due;
}

/** Whether an effect has no timing of its own (plays as the passage starts). */
export function isUntimed(fx: PassageSfx): boolean {
  const o = fx.offsetMs;
  return !(typeof o === 'number' && Number.isFinite(o) && o >= 0);
}

/** Indices of the untimed effects that haven't played yet, marking them played. */
export function takeUntimedSfx(sfx: PassageSfx[], played: Set<number>): number[] {
  const due: number[] = [];
  sfx.forEach((fx, i) => {
    if (!played.has(i) && isUntimed(fx)) {
      played.add(i);
      due.push(i);
    }
  });
  return due;
}
