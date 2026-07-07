// Unit tests for the string-diff utility used by the frontend's
// Yjs text-field binding (useYjsTextField). Lives in backend
// because backend has the jest runner; the function itself is in
// shared/ so the frontend can import it too. No backend-side
// consumer of computeStringDiff exists yet.
//
// Why this matters: getting the diff wrong corrupts collaborative
// text edits. If we always replace the full string, two
// simultaneous keystrokes resolve as "last writer wins" instead of
// merging at their offsets. The cases below pin every shape of
// edit that comes off a controlled <input>.

import { computeStringDiff } from '@wanderline/shared';

describe('computeStringDiff', () => {
  it('returns a no-op when strings are identical', () => {
    expect(computeStringDiff('hello', 'hello')).toEqual({
      at: 0,
      deleteLen: 0,
      insert: '',
    });
  });

  it('detects a single insert at the end (typing a letter)', () => {
    expect(computeStringDiff('hell', 'hello')).toEqual({
      at: 4,
      deleteLen: 0,
      insert: 'o',
    });
  });

  it('detects a single delete at the end (backspace)', () => {
    expect(computeStringDiff('hello', 'hell')).toEqual({
      at: 4,
      deleteLen: 1,
      insert: '',
    });
  });

  it('detects an insert in the middle (paste mid-string)', () => {
    expect(computeStringDiff('hello', 'hel-lo')).toEqual({
      at: 3,
      deleteLen: 0,
      insert: '-',
    });
  });

  it('detects a delete from the middle (select-and-delete)', () => {
    expect(computeStringDiff('hel-lo', 'hello')).toEqual({
      at: 3,
      deleteLen: 1,
      insert: '',
    });
  });

  it('detects a replace at the start', () => {
    expect(computeStringDiff('hello world', 'jello world')).toEqual({
      at: 0,
      deleteLen: 1,
      insert: 'j',
    });
  });

  it('detects a replace at the end', () => {
    expect(computeStringDiff('hello world', 'hello earth')).toEqual({
      at: 6,
      deleteLen: 5,
      insert: 'earth',
    });
  });

  it('handles a full replacement of disjoint strings', () => {
    expect(computeStringDiff('abc', 'xyz')).toEqual({
      at: 0,
      deleteLen: 3,
      insert: 'xyz',
    });
  });

  it('handles insert at offset 0 (typing into an empty input)', () => {
    expect(computeStringDiff('', 'a')).toEqual({
      at: 0,
      deleteLen: 0,
      insert: 'a',
    });
  });

  it('handles delete-all (Cmd-A then backspace)', () => {
    expect(computeStringDiff('hello', '')).toEqual({
      at: 0,
      deleteLen: 5,
      insert: '',
    });
  });

  it('handles a long contiguous paste', () => {
    expect(computeStringDiff('hi.', 'hi, world!')).toEqual({
      at: 2,
      deleteLen: 1,
      insert: ', world!',
    });
  });

  it('handles unicode correctly (multi-byte chars stay together)', () => {
    // emoji are 2 code units each; the diff is character-index, so
    // a single emoji insert reports deleteLen=0 + insert='🎉'
    expect(computeStringDiff('party!', 'party 🎉!')).toEqual({
      at: 5,
      deleteLen: 0,
      insert: ' 🎉',
    });
  });
});
