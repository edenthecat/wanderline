import { describe, expect, it } from 'vitest';
import { choiceCueVariants } from './App';

// A choice's own audio cue, addressed by the choice's stable id
// (DEV-199 stable-id rollout) — must take priority over the ordinal
// choice1/choice2 fields, which may belong to a DIFFERENT choice if
// a story's choices have ever been reordered. A choice with no id
// (data from before the rollout) has no other way to carry audio.

describe('choiceCueVariants', () => {
  it('resolves by the choice’s own id when present, ignoring a stale ordinal field', () => {
    const choice = { text: 'Go', target: 'next', id: 'choice-on' };
    const audio = {
      choice1: [{ file: 'wrong-cue.mp3' }],
      choices: { 'choice-on': [{ file: 'right-cue.mp3' }] },
    };
    expect(choiceCueVariants(choice, audio, 0)).toEqual([{ file: 'right-cue.mp3' }]);
  });

  it('falls back to the ordinal field when the choice has no id', () => {
    const choice = { text: 'Go', target: 'next' };
    const audio = { choice1: [{ file: 'n1.mp3' }] };
    expect(choiceCueVariants(choice, audio, 0)).toEqual([{ file: 'n1.mp3' }]);
  });

  it('uses choice2 for position 1', () => {
    const choice = { text: 'Go', target: 'next' };
    const audio = { choice2: [{ file: 'n2.mp3' }] };
    expect(choiceCueVariants(choice, audio, 1)).toEqual([{ file: 'n2.mp3' }]);
  });

  it('returns no candidates for an id’d choice with nothing attached, even if an ordinal field exists', () => {
    // This is the whole point of addressing by id: a choice with an
    // id is NEVER allowed to pick up audio meant for a different
    // choice via the position-based fallback.
    const choice = { text: 'Go', target: 'next', id: 'choice-on' };
    const audio = { choice1: [{ file: 'belongs-to-someone-else.mp3' }] };
    expect(choiceCueVariants(choice, audio, 0)).toEqual([]);
  });

  it('returns an empty array when there is no choice at that position', () => {
    expect(choiceCueVariants(undefined, { choice1: [{ file: 'x.mp3' }] }, 0)).toEqual([]);
  });

  it('returns an empty array when there is no audio at all', () => {
    expect(choiceCueVariants({ text: 'Go', target: 'next' }, undefined, 0)).toEqual([]);
  });
});
