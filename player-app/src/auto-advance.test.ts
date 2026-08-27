import { describe, expect, it } from 'vitest';
import { autoAdvanceTarget } from './App';

// Auto-advance is a project setting only — there is no per-node
// override — and it applies only where there is exactly one way
// forward. A passage offering a real decision must never take it on
// the listener's behalf.
const ON = { autoAdvance: true };
const OFF = { autoAdvance: false };

describe('autoAdvanceTarget', () => {
  it('is off unless the project turns it on', () => {
    expect(autoAdvanceTarget({ choices: [{ target: 'b' }] }, undefined)).toBeNull();
    expect(autoAdvanceTarget({ choices: [{ target: 'b' }] }, {})).toBeNull();
    expect(autoAdvanceTarget({ choices: [{ target: 'b' }] }, OFF)).toBeNull();
  });

  it('advances through a single choice', () => {
    expect(autoAdvanceTarget({ choices: [{ target: 'b' }] }, ON)).toBe('b');
  });

  it('advances through a divert when there are no choices', () => {
    expect(autoAdvanceTarget({ choices: [], divert: 'b' }, ON)).toBe('b');
  });

  // The rule that matters: a branch is the listener's to make.
  it('never advances a passage that offers a real decision', () => {
    expect(autoAdvanceTarget({ choices: [{ target: 'b' }, { target: 'c' }] }, ON)).toBeNull();
    expect(
      autoAdvanceTarget({ choices: [{ target: 'b' }, { target: 'c' }], divert: 'd' }, ON),
    ).toBeNull();
  });

  it('does not advance a passage with nowhere to go', () => {
    expect(autoAdvanceTarget({ choices: [], divert: null }, ON)).toBeNull();
    expect(autoAdvanceTarget({}, ON)).toBeNull();
    expect(autoAdvanceTarget(null, ON)).toBeNull();
  });

  // A single choice wins over a divert; that's the path the author
  // actually offered.
  it('prefers the single choice when a divert is also present', () => {
    expect(autoAdvanceTarget({ choices: [{ target: 'b' }], divert: 'd' }, ON)).toBe('b');
  });
});
