import { describe, expect, it } from 'vitest';
import { choiceAudioDelayMs } from './App';

// The pause before a choice option's audio starts. Both setTimeout call
// sites in App.tsx read it through this one function, so this is the
// one place all of the guard's rules need covering — see
// MAX_SET_TIMEOUT_DELAY_MS, shared with the backend's own guard via
// @wanderline/shared.

describe('choiceAudioDelayMs', () => {
  it('falls back to 3 seconds when unset', () => {
    expect(choiceAudioDelayMs(undefined)).toBe(3000);
    expect(choiceAudioDelayMs({})).toBe(3000);
  });

  it('uses the project value when present', () => {
    expect(choiceAudioDelayMs({ choiceAudioDelayMs: 1500 })).toBe(1500);
  });

  it('preserves zero rather than falling back to it', () => {
    expect(choiceAudioDelayMs({ choiceAudioDelayMs: 0 })).toBe(0);
  });

  // The backend guard clamps every fresh write, but a story built from a
  // settings row written before that guard existed can still carry a
  // larger value — a build is a static snapshot the guard's later fix
  // can't reach retroactively. Passing that straight to setTimeout would
  // silently erase the pause: setTimeout clamps a delay past what a
  // signed 32-bit millisecond count can hold to fire almost immediately,
  // the opposite of what such a stored value intends.
  it('caps a legacy value beyond what setTimeout can represent', () => {
    expect(choiceAudioDelayMs({ choiceAudioDelayMs: 9_999_999_999 })).toBe(2_147_483_647);
  });

  // A negative pause means nothing to setTimeout either — it doesn't
  // reject one, it just fires almost immediately, silently discarding
  // whatever pause a project meant to have. Floored the same way the
  // backend guard and the editor's own display both floor it.
  it('floors a legacy negative value at zero', () => {
    expect(choiceAudioDelayMs({ choiceAudioDelayMs: -500 })).toBe(0);
  });

  // A non-numeric legacy value would otherwise reach setTimeout as NaN,
  // which resolves to an immediate fire the same way a negative does —
  // falls back to the 3-second default instead, same as the editor.
  it('falls back to the default for a non-numeric legacy value', () => {
    expect(choiceAudioDelayMs({ choiceAudioDelayMs: 'soon' as unknown as number })).toBe(3000);
    expect(choiceAudioDelayMs({ choiceAudioDelayMs: NaN })).toBe(3000);
  });
});
