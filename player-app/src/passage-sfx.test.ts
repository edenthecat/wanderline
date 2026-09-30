import { describe, it, expect } from 'vitest';
import { isUntimed, sfxOffset, takeDueSfx, takeUntimedSfx } from './passage-sfx';

describe('sfxOffset', () => {
  it('treats a missing, negative or non-finite offset as the start', () => {
    expect(sfxOffset({ file: 'a' })).toBe(0);
    expect(sfxOffset({ file: 'a', offsetMs: -10 })).toBe(0);
    expect(sfxOffset({ file: 'a', offsetMs: Number.NaN })).toBe(0);
    expect(sfxOffset({ file: 'a', offsetMs: 1200 })).toBe(1200);
  });
});

describe('takeDueSfx', () => {
  const sfx = [
    { file: 'door' },
    { file: 'bell', offsetMs: 1000 },
    { file: 'door', offsetMs: 3000 },
  ];

  it('fires each effect once, when its offset is reached', () => {
    const played = new Set<number>();
    expect(takeDueSfx(sfx, 0, played)).toEqual([0]);
    expect(takeDueSfx(sfx, 500, played)).toEqual([]);
    expect(takeDueSfx(sfx, 1250, played)).toEqual([1]);
    expect(takeDueSfx(sfx, 1500, played)).toEqual([]);
    expect(takeDueSfx(sfx, 3000, played)).toEqual([2]);
    expect(takeDueSfx(sfx, 9000, played)).toEqual([]);
  });

  it('catches up on everything already past, e.g. after resuming mid-passage', () => {
    expect(takeDueSfx(sfx, 5000, new Set())).toEqual([0, 1, 2]);
  });

  it('takes everything still pending when the narration ends', () => {
    const played = new Set([0]);
    expect(takeDueSfx(sfx, Number.POSITIVE_INFINITY, played)).toEqual([1, 2]);
  });
});

describe('untimed effects', () => {
  it('are the ones with no timing of their own; an explicit 0 is timed', () => {
    expect(isUntimed({ file: 'a' })).toBe(true);
    expect(isUntimed({ file: 'a', offsetMs: 0 })).toBe(false);
    expect(isUntimed({ file: 'a', offsetMs: 500 })).toBe(false);
  });

  it('are taken once each, leaving timed ones for the narration', () => {
    const sfx = [{ file: 'door' }, { file: 'bell', offsetMs: 0 }, { file: 'gong' }];
    const played = new Set<number>();
    expect(takeUntimedSfx(sfx, played)).toEqual([0, 2]);
    expect(takeUntimedSfx(sfx, played)).toEqual([]);
    expect(takeDueSfx(sfx, 0, played)).toEqual([1]);
  });
});
