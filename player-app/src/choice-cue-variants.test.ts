import { describe, expect, it } from 'vitest';
import { choiceCueVariants } from './App';

// A choice's own audio cue, addressed by the choice's stable id
// (DEV-199 stable-id rollout) is additive, not a replacement — the
// ordinal choice1/choice2 fields win when assigned (found in review:
// this used to have the precedence backwards, contradicting the PR's
// own stated contract that id-based audio must not change behavior
// for any existing 2-choice story). Id-addressed audio is only the
// FALLBACK, used when the ordinal slot is empty — both because that's
// the advertised contract, and because an id is minted fresh by
// randomUUID() on every parse (NOT stable across a full source
// re-upload), so an author's pre-existing choice1/choice2 cue must
// keep working after their next re-upload gives this choice a (new)
// id with nothing attached to it yet.

describe('choiceCueVariants', () => {
  it('resolves by the ordinal field when BOTH it and the choice’s own id have a cue assigned', () => {
    const choice = { text: 'Go', target: 'next', id: 'choice-on' };
    const audio = {
      choice1: [{ file: 'ordinal-cue.mp3' }],
      choices: { 'choice-on': [{ file: 'id-cue.mp3' }] },
    };
    expect(choiceCueVariants(choice, audio, 0)).toEqual([{ file: 'ordinal-cue.mp3' }]);
  });

  it('falls back to the id-addressed cue when the ordinal field is empty', () => {
    const choice = { text: 'Go', target: 'next', id: 'choice-on' };
    const audio = { choices: { 'choice-on': [{ file: 'id-cue.mp3' }] } };
    expect(choiceCueVariants(choice, audio, 0)).toEqual([{ file: 'id-cue.mp3' }]);
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
