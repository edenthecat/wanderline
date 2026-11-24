import {
  isValidAudioType,
  isChoiceAudioType,
  choiceIdFromAudioType,
  audioTypeForChoice,
} from '../choice-audio.js';

describe('isValidAudioType', () => {
  it('accepts every fixed slot', () => {
    for (const t of ['voiceover', 'ambience', 'sfx', 'choice1', 'choice2']) {
      expect(isValidAudioType(t)).toBe(true);
    }
  });

  it('accepts a choice:<id> audio type', () => {
    expect(isValidAudioType('choice:abc-123')).toBe(true);
  });

  it('rejects an unrecognized string', () => {
    expect(isValidAudioType('background_music')).toBe(false);
  });

  // Found in review: both POST /assignments and bulk-reassign only
  // checked the request body's audioType for truthiness before
  // calling this — a non-string value reaching `.startsWith` inside
  // threw, turning a malformed request into a 500 instead of the
  // intended 400 validation response.
  it('rejects (rather than throwing on) a non-string audioType', () => {
    expect(isValidAudioType(1)).toBe(false);
    expect(isValidAudioType({})).toBe(false);
    expect(isValidAudioType([])).toBe(false);
    expect(isValidAudioType(true)).toBe(false);
    expect(isValidAudioType(null)).toBe(false);
    expect(isValidAudioType(undefined)).toBe(false);
  });
});

describe('choice audio encoding', () => {
  it('round-trips a choice id through the audio type encoding', () => {
    const audioType = audioTypeForChoice('choice-id-1');
    expect(isChoiceAudioType(audioType)).toBe(true);
    expect(choiceIdFromAudioType(audioType)).toBe('choice-id-1');
  });

  it('does not treat a fixed slot as a choice audio type', () => {
    expect(isChoiceAudioType('voiceover')).toBe(false);
  });
});
