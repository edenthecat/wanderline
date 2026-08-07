import { describe, it, expect } from 'vitest';
import { promoteWeight, toggleWeight } from '../font-weights';

// The regression these guard: toggleWeight used to end in `.sort()`.
// Because the backend takes the FIRST entry as the primary weight, that
// pinned the primary to the numerically lowest selection and gave
// authors no way to choose. Checking 400 and 700 always produced 400.

describe('toggleWeight', () => {
  it('adds a weight to an empty list', () => {
    expect(toggleWeight(undefined, '400')).toEqual(['400']);
    expect(toggleWeight([], '400')).toEqual(['400']);
  });

  it('appends rather than sorting, so the existing primary keeps its slot', () => {
    expect(toggleWeight(['700'], '400')).toEqual(['700', '400']);
  });

  it('never reorders on repeated additions', () => {
    let w: string[] = [];
    w = toggleWeight(w, '700');
    w = toggleWeight(w, '400');
    w = toggleWeight(w, '500');
    expect(w).toEqual(['700', '400', '500']);
  });

  it('removes a weight already present', () => {
    expect(toggleWeight(['400', '700'], '400')).toEqual(['700']);
  });

  it('preserves order of the survivors on removal', () => {
    expect(toggleWeight(['700', '400', '500'], '400')).toEqual(['700', '500']);
  });

  it('round-trips back to the original set', () => {
    const start = ['700', '400'];
    expect(toggleWeight(toggleWeight(start, '500'), '500')).toEqual(start);
  });

  it('does not mutate the input array', () => {
    const start = ['400'];
    toggleWeight(start, '700');
    expect(start).toEqual(['400']);
  });

  it('removing the last weight yields an empty list', () => {
    expect(toggleWeight(['400'], '400')).toEqual([]);
  });
});

describe('promoteWeight', () => {
  it('moves the chosen weight to the front', () => {
    expect(promoteWeight(['400', '700'], '700')).toEqual(['700', '400']);
  });

  it('is a no-op when the weight is already primary', () => {
    expect(promoteWeight(['700', '400'], '700')).toEqual(['700', '400']);
  });

  it('preserves the relative order of the rest', () => {
    expect(promoteWeight(['400', '500', '600', '700'], '600')).toEqual([
      '600',
      '400',
      '500',
      '700',
    ]);
  });

  it('ignores a weight that is not selected', () => {
    expect(promoteWeight(['400'], '900')).toEqual(['400']);
  });

  it('handles an empty or undefined list', () => {
    expect(promoteWeight(undefined, '400')).toEqual([]);
    expect(promoteWeight([], '400')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const start = ['400', '700'];
    promoteWeight(start, '700');
    expect(start).toEqual(['400', '700']);
  });

  it('promoting twice is not lossy', () => {
    const once = promoteWeight(['400', '500', '700'], '700');
    const twice = promoteWeight(once, '500');
    expect(twice).toEqual(['500', '700', '400']);
    expect(twice).toHaveLength(3);
  });
});

describe('toggle + promote together', () => {
  // The author flow the fix exists for: check 400, check 700, then
  // decide 700 should be the one the player actually renders.
  it('lets an author make a later selection primary', () => {
    let w = toggleWeight(undefined, '400');
    w = toggleWeight(w, '700');
    expect(w[0]).toBe('400');
    w = promoteWeight(w, '700');
    expect(w[0]).toBe('700');
    expect(w).toEqual(['700', '400']);
  });

  // Unchecking the primary hands the role to the next in line rather
  // than leaving a dangling reference to a weight that is gone.
  it('passes the primary role on when the primary is deselected', () => {
    const w = toggleWeight(['700', '400', '500'], '700');
    expect(w[0]).toBe('400');
  });
});
