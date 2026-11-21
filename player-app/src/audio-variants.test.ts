import { describe, it, expect } from 'vitest';
import { resolveAudioVariant, allAudioVariantFiles } from './audio-variants';

describe('resolveAudioVariant', () => {
  it('returns undefined for an empty or missing slot', () => {
    expect(resolveAudioVariant(undefined, {})).toBeUndefined();
    expect(resolveAudioVariant([], {})).toBeUndefined();
  });

  it('returns the one unconditioned candidate when there are no conditions', () => {
    expect(resolveAudioVariant([{ file: 'vo.mp3' }], {})).toBe('vo.mp3');
  });

  it('picks the first matching conditioned candidate, checked in order', () => {
    const variants = [
      {
        file: 'angry.mp3',
        condition: { variable: 'mood', operator: '==' as const, value: 'angry' },
      },
      { file: 'sad.mp3', condition: { variable: 'mood', operator: '==' as const, value: 'sad' } },
      { file: 'normal.mp3' },
    ];
    expect(resolveAudioVariant(variants, { mood: 'sad' })).toBe('sad.mp3');
  });

  it('falls back to the unconditioned default when no condition matches', () => {
    const variants = [
      {
        file: 'angry.mp3',
        condition: { variable: 'mood', operator: '==' as const, value: 'angry' },
      },
      { file: 'normal.mp3' },
    ];
    expect(resolveAudioVariant(variants, { mood: 'cheerful' })).toBe('normal.mp3');
  });

  it('returns undefined when every candidate is conditioned and none match', () => {
    const variants = [
      {
        file: 'angry.mp3',
        condition: { variable: 'mood', operator: '==' as const, value: 'angry' },
      },
    ];
    expect(resolveAudioVariant(variants, { mood: 'cheerful' })).toBeUndefined();
  });

  it('does not crash on a condition referencing an undeclared variable — just skips it', () => {
    const variants = [
      { file: 'x.mp3', condition: { variable: 'missing', operator: '==' as const, value: 1 } },
      { file: 'default.mp3' },
    ];
    expect(resolveAudioVariant(variants, {})).toBe('default.mp3');
  });
});

describe('allAudioVariantFiles', () => {
  it('lists every candidate file, for preloading', () => {
    const variants = [
      {
        file: 'angry.mp3',
        condition: { variable: 'mood', operator: '==' as const, value: 'angry' },
      },
      { file: 'normal.mp3' },
    ];
    expect(allAudioVariantFiles(variants)).toEqual(['angry.mp3', 'normal.mp3']);
  });

  it('returns an empty array for an undefined slot', () => {
    expect(allAudioVariantFiles(undefined)).toEqual([]);
  });
});
