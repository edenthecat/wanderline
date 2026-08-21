import { mergeSettingsObject } from '../projects-settings.js';

// Coverage for the settings merge, prompted by per-choice indicator
// sounds being unreachable in the product.
//
// story-data-builder read settings.choiceIndicatorAudio.choice1FileId /
// choice2FileId, and the player honoured them, but the key was missing
// from the endpoint's allow-list. A PATCH carrying it was dropped with
// no error and no warning, so the feature could only be enabled by
// editing the database. Nothing failed loudly, which is why it sat
// half-built.

describe('mergeSettingsObject — allow-list', () => {
  it('keeps choiceIndicatorAudio instead of dropping it', () => {
    const merged = mergeSettingsObject({}, { choiceIndicatorAudio: { choice1FileId: 'file-a' } });
    expect(merged.choiceIndicatorAudio).toEqual({ choice1FileId: 'file-a' });
  });

  it('still drops keys nobody has wired up', () => {
    const merged = mergeSettingsObject({}, { somethingInvented: true });
    expect(merged.somethingInvented).toBeUndefined();
  });

  it('leaves the other known keys alone', () => {
    const merged = mergeSettingsObject(
      { voiceoverVolume: 80 },
      { choiceIndicatorAudio: { choice1FileId: 'file-a' } },
    );
    expect(merged.voiceoverVolume).toBe(80);
  });
});

describe('mergeSettingsObject — nested merge for choiceIndicatorAudio', () => {
  // The editor patches one dropdown at a time. A wholesale replace
  // would clear the other choice every time either was changed.
  it('setting choice 1 does not clear choice 2', () => {
    const merged = mergeSettingsObject(
      { choiceIndicatorAudio: { choice1FileId: 'file-a', choice2FileId: 'file-b' } },
      { choiceIndicatorAudio: { choice1FileId: 'file-c' } },
    );
    expect(merged.choiceIndicatorAudio).toEqual({
      choice1FileId: 'file-c',
      choice2FileId: 'file-b',
    });
  });

  it('setting choice 2 does not clear choice 1', () => {
    const merged = mergeSettingsObject(
      { choiceIndicatorAudio: { choice1FileId: 'file-a' } },
      { choiceIndicatorAudio: { choice2FileId: 'file-b' } },
    );
    expect(merged.choiceIndicatorAudio).toEqual({
      choice1FileId: 'file-a',
      choice2FileId: 'file-b',
    });
  });

  // Choosing "same as default" sends null, which has to persist as a
  // cleared override rather than being ignored as absent.
  it('clearing one side back to the default is preserved', () => {
    const merged = mergeSettingsObject(
      { choiceIndicatorAudio: { choice1FileId: 'file-a', choice2FileId: 'file-b' } },
      { choiceIndicatorAudio: { choice1FileId: null } },
    );
    expect(merged.choiceIndicatorAudio).toEqual({
      choice1FileId: null,
      choice2FileId: 'file-b',
    });
  });

  it('builds the object when the project has never set one', () => {
    const merged = mergeSettingsObject({}, { choiceIndicatorAudio: { choice2FileId: 'file-b' } });
    expect(merged.choiceIndicatorAudio).toEqual({ choice2FileId: 'file-b' });
  });

  it('does not disturb the separate default indicator setting', () => {
    const merged = mergeSettingsObject(
      { defaultIndicatorAudioId: 'default-file' },
      { choiceIndicatorAudio: { choice1FileId: 'file-a' } },
    );
    expect(merged.defaultIndicatorAudioId).toBe('default-file');
    expect(merged.choiceIndicatorAudio).toEqual({ choice1FileId: 'file-a' });
  });

  // Guards the keys that were already merging nested, so adding a third
  // to the set did not change their behaviour.
  it('leaves the existing nested-merge keys behaving as before', () => {
    const theme = mergeSettingsObject(
      { theme: { bodyFont: 'Inter', customCss: '.a{}' } },
      { theme: { bodyFont: 'Roboto' } },
    );
    expect(theme.theme).toEqual({ bodyFont: 'Roboto', customCss: '.a{}' });

    const bt = mergeSettingsObject(
      { bluetoothControls: { nextTrack: 'choice1', previousTrack: 'choice2' } },
      { bluetoothControls: { nextTrack: 'confirm' } },
    );
    expect(bt.bluetoothControls).toEqual({ nextTrack: 'confirm', previousTrack: 'choice2' });
  });
});
