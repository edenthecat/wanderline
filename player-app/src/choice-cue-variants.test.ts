import { describe, expect, it } from 'vitest';
import { choiceCueVariants } from './App';

// A choice's own audio cue, addressed by the choice's stable id
// (DEV-199 stable-id rollout) — takes priority over the ordinal
// choice1/choice2 fields when it has one. Falls back to the ordinal
// field when there's nothing under the id, because ids are minted
// fresh by randomUUID() on every parse — NOT stable across a full
// source re-upload — so an author's pre-existing choice1/choice2 cue
// must keep working after their next re-upload gives this choice a
// (new) id, even though that trades away perfect reorder-safety for
// the narrower in-between window before the choice gets its own
// id-addressed cue.

describe('choiceCueVariants', () => {
  it('resolves by the choice’s own id when present, over the ordinal field', () => {
    const choice = { text: 'Go', target: 'next', id: 'choice-on' };
    const audio = {
      choice1: [{ file: 'old-cue.mp3' }],
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

  // Regression: an id is freshly randomUUID()'d on every parse, so a
  // re-upload of unchanged Ink/Twee source gives every choice a NEW
  // id — if a choice with no cue of its own id never fell back to
  // the ordinal field, every pre-existing choice1/choice2 cue in
  // every story would silently stop playing the next time its source
  // is re-uploaded.
  it('falls back to the ordinal field even when the choice has an id, if nothing is attached under that id', () => {
    const choice = { text: 'Go', target: 'next', id: 'choice-on' };
    const audio = { choice1: [{ file: 'pre-existing-cue.mp3' }] };
    expect(choiceCueVariants(choice, audio, 0)).toEqual([{ file: 'pre-existing-cue.mp3' }]);
  });

  it('returns an empty array when there is no choice at that position', () => {
    expect(choiceCueVariants(undefined, { choice1: [{ file: 'x.mp3' }] }, 0)).toEqual([]);
  });

  it('returns an empty array when there is no audio at all', () => {
    expect(choiceCueVariants({ text: 'Go', target: 'next' }, undefined, 0)).toEqual([]);
  });
});
