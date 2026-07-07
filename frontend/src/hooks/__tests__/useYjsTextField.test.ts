import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { adjustSelectionForDelta, computeStringDiff } from '../useYjsTextField';

// pin the pure helpers behind useYjsTextField. Both are
// prone to off-by-one bugs that only surface in concurrent-edit spot
// checks — a unit test is much faster feedback than "type in two
// tabs and see if the cursor jumps".

describe('computeStringDiff', () => {
  it('returns a zero-op when the strings are identical', () => {
    expect(computeStringDiff('hello', 'hello')).toEqual({
      at: 0,
      deleteLen: 0,
      insert: '',
    });
  });

  it('detects a simple append', () => {
    expect(computeStringDiff('hello', 'hello world')).toEqual({
      at: 5,
      deleteLen: 0,
      insert: ' world',
    });
  });

  it('detects a middle insertion', () => {
    expect(computeStringDiff('go home', 'go back home')).toEqual({
      at: 3,
      deleteLen: 0,
      insert: 'back ',
    });
  });

  it('detects a single-char delete from the middle', () => {
    expect(computeStringDiff('hello', 'helo')).toEqual({
      at: 3,
      deleteLen: 1,
      insert: '',
    });
  });

  it('detects a replace as a delete + insert at the divergence point', () => {
    expect(computeStringDiff('cat', 'car')).toEqual({
      at: 2,
      deleteLen: 1,
      insert: 'r',
    });
  });

  it('handles an empty starting string', () => {
    expect(computeStringDiff('', 'seeded')).toEqual({
      at: 0,
      deleteLen: 0,
      insert: 'seeded',
    });
  });

  it('handles a full delete', () => {
    expect(computeStringDiff('gone', '')).toEqual({
      at: 0,
      deleteLen: 4,
      insert: '',
    });
  });

  it('collapses shared prefix + suffix so the deleteLen is minimal', () => {
    // The naive "delete everything and reinsert" would give
    // { at: 0, deleteLen: 12, insert: 'the ferry ride' } — the
    // helper's whole point is producing the smaller diff.
    const diff = computeStringDiff('the boat ride', 'the ferry ride');
    expect(diff.at).toBe(4);
    expect(diff.deleteLen).toBe(4);
    expect(diff.insert).toBe('ferry');
  });
});

// Build a synthetic Y.YTextEvent by stubbing the `delta` field. The
// hook's cursor-preservation logic only reads `event.delta`, so this
// is enough to exercise it without a full Y.Doc round-trip.
function eventWithDelta(delta: Y.YTextEvent['delta']): Y.YTextEvent {
  return { delta } as Y.YTextEvent;
}

describe('adjustSelectionForDelta', () => {
  it('leaves selection unchanged when the delta is entirely retain', () => {
    const event = eventWithDelta([{ retain: 10 }]);
    expect(adjustSelectionForDelta(event, 4, 6)).toEqual({ start: 4, end: 6 });
  });

  it('shifts the selection right when a remote insert lands before the cursor', () => {
    // Remote peer inserted 5 chars at offset 2.
    const event = eventWithDelta([{ retain: 2 }, { insert: 'hello' }]);
    expect(adjustSelectionForDelta(event, 4, 6)).toEqual({ start: 9, end: 11 });
  });

  it('leaves the selection alone when a remote insert lands after the selection', () => {
    const event = eventWithDelta([{ retain: 10 }, { insert: 'trailing' }]);
    expect(adjustSelectionForDelta(event, 4, 6)).toEqual({ start: 4, end: 6 });
  });

  it('shifts the selection left when a remote delete lands before the cursor', () => {
    // Remote peer deleted 3 chars at offset 1.
    const event = eventWithDelta([{ retain: 1 }, { delete: 3 }]);
    expect(adjustSelectionForDelta(event, 6, 8)).toEqual({ start: 3, end: 5 });
  });

  it('collapses the selection onto the delete point when the range overlaps the delete', () => {
    // Selection was [4, 8]; remote deleted 5 chars starting at 3 —
    // covers the entire selection. Both ends collapse to 3.
    const event = eventWithDelta([{ retain: 3 }, { delete: 5 }]);
    expect(adjustSelectionForDelta(event, 4, 8)).toEqual({ start: 3, end: 3 });
  });
});
