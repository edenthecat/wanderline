import { describe, expect, it } from 'vitest';
import { resolveVolumes, volumeToGain, VOLUME_DEFAULTS } from '@wanderline/shared';

// The resolution chain the player seeds its volume state from, now
// shared with the editor's in-context audition so the two can't drift.
//
// The two faults this chain has already shipped, both pinned below:
//   - the resolved value multiplied by the project setting a SECOND
//     time at the apply sites, squaring the author's choice;
//   - a fallback here that didn't match the editor's slider default,
//     which only looked right because of the squaring.

describe('resolveVolumes', () => {
  it('prefers the listener over the author over the fallback', () => {
    const settings = { voiceoverVolume: 60, backgroundMusicVolume: 40, indicatorVolume: 20 };
    expect(resolveVolumes(settings, { bgMusic: 10 })).toEqual({
      voiceover: 60, // author's, no override
      backgroundMusic: 10, // listener's
      indicator: 20,
    });
  });

  it('falls back only for the settings an author has not chosen', () => {
    expect(resolveVolumes({ backgroundMusicVolume: 40 })).toEqual({
      voiceover: VOLUME_DEFAULTS.voiceover,
      backgroundMusic: 40,
      indicator: VOLUME_DEFAULTS.indicator,
    });
  });

  it('uses the same fallbacks the editor shows on its sliders', () => {
    expect(resolveVolumes()).toEqual({ ...VOLUME_DEFAULTS });
    expect(VOLUME_DEFAULTS).toEqual({ voiceover: 100, backgroundMusic: 30, indicator: 50 });
  });

  // A mangled localStorage payload used to be applied verbatim:
  // `volumes.voiceover !== undefined` let a null through, and a null
  // gain silences an element outright.
  it('ignores corrupt values instead of applying them', () => {
    const settings = { voiceoverVolume: 60 };
    const overrides = { voiceover: null, bgMusic: NaN } as unknown as { voiceover?: number };
    expect(resolveVolumes(settings, overrides)).toEqual({
      voiceover: 60,
      backgroundMusic: VOLUME_DEFAULTS.backgroundMusic,
      indicator: VOLUME_DEFAULTS.indicator,
    });
  });

  // element.volume throws for anything above 1, which would kill
  // playback outright rather than merely being loud.
  it('clamps out-of-range values into 0-100', () => {
    expect(resolveVolumes({ voiceoverVolume: 500, indicatorVolume: -20 })).toMatchObject({
      voiceover: 100,
      indicator: 0,
    });
  });
});

describe('volumeToGain', () => {
  it('is the resolved percentage over 100 and nothing else', () => {
    // If a call site ever squares again, these are the numbers that
    // move: 30 -> 0.09, 50 -> 0.25.
    expect(volumeToGain(30)).toBeCloseTo(0.3, 5);
    expect(volumeToGain(50)).toBeCloseTo(0.5, 5);
    expect(volumeToGain(100)).toBe(1);
    expect(volumeToGain(0)).toBe(0);
  });

  it('never hands an element a gain it would throw on', () => {
    expect(volumeToGain(150)).toBe(1);
    expect(volumeToGain(-1)).toBe(0);
    expect(volumeToGain(NaN)).toBe(0);
  });
});
