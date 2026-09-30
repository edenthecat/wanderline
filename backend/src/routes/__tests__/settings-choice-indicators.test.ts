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

  // Same failure mode as choiceIndicatorAudio: the build pipeline
  // reads settings.language for <html lang> and the manifest, so
  // dropping it here would leave the Settings control a no-op and
  // every build stuck on English.
  it('keeps the project language', () => {
    const merged = mergeSettingsObject({}, { language: 'pt-BR' });
    expect(merged.language).toBe('pt-BR');
  });

  // The player's ambience + sound-effect level. Same failure mode: the
  // Volumes tab slider would save nothing without it on the list.
  it('keeps the ambience volume', () => {
    const merged = mergeSettingsObject({}, { ambienceVolume: 40 });
    expect(merged.ambienceVolume).toBe(40);
  });

  // It's a percentage everywhere it's shown.
  it('holds the ambience volume to 0-100 and drops a non-number', () => {
    expect(mergeSettingsObject({}, { ambienceVolume: 1000 }).ambienceVolume).toBe(100);
    expect(mergeSettingsObject({}, { ambienceVolume: -5 }).ambienceVolume).toBe(0);
    expect(
      mergeSettingsObject({ ambienceVolume: 30 }, { ambienceVolume: 'loud' }).ambienceVolume,
    ).toBe(30);
    expect(mergeSettingsObject({}, { ambienceVolume: Number.NaN }).ambienceVolume).toBeUndefined();
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

// The allow-list decides which keys survive; these cover the separate
// question of whether a surviving key's *value* is one the rest of the
// system can render. choiceAudioDelayMs has two readers with different
// assumptions — the player awaits it as a timer, the editor renders it
// on a slider with a floor of 0 — and nothing used to hold it to either.
describe('mergeSettingsObject — choiceAudioDelayMs range', () => {
  it('stores a sane value unchanged', () => {
    const merged = mergeSettingsObject({}, { choiceAudioDelayMs: 1500 });
    expect(merged.choiceAudioDelayMs).toBe(1500);
  });

  it('keeps zero rather than treating it as absent', () => {
    const merged = mergeSettingsObject({ choiceAudioDelayMs: 3000 }, { choiceAudioDelayMs: 0 });
    expect(merged.choiceAudioDelayMs).toBe(0);
  });

  // A negative pause means nothing to either reader, and it used to
  // leave the editor's slider (clamped to 0 by the native control) and
  // the number printed beside it showing different values.
  it('clamps a negative pause to zero', () => {
    const merged = mergeSettingsObject({}, { choiceAudioDelayMs: -500 });
    expect(merged.choiceAudioDelayMs).toBe(0);
  });

  // No *product* ceiling on purpose: the player simply waits this long,
  // so a cap here would be the settings contract inventing a pacing
  // opinion that belongs to the author.
  it('leaves a long pause alone', () => {
    const merged = mergeSettingsObject({}, { choiceAudioDelayMs: 30000 });
    expect(merged.choiceAudioDelayMs).toBe(30000);
  });

  // ...but there is still a *technical* ceiling: both readers drive this
  // through setTimeout, which takes a signed 32-bit millisecond count and
  // clamps anything past it to fire almost immediately. A value beyond
  // that wouldn't lengthen the pause, it would erase it — the opposite of
  // what storing such a value intends — so it's held to what the timer
  // can actually represent.
  it('caps a pause beyond what setTimeout can represent', () => {
    const merged = mergeSettingsObject({}, { choiceAudioDelayMs: 9_999_999_999 });
    expect(merged.choiceAudioDelayMs).toBe(2_147_483_647);
  });

  // The player's `await delay(...)` would resolve immediately on a
  // non-number and the editor would print "NaNs". Drop it and keep
  // whatever was already stored.
  it('drops a non-numeric pause instead of storing it', () => {
    for (const bad of ['2000', null, NaN, Infinity, {}, []]) {
      const merged = mergeSettingsObject(
        { choiceAudioDelayMs: 3000 },
        { choiceAudioDelayMs: bad as unknown as number },
      );
      expect(merged.choiceAudioDelayMs).toBe(3000);
    }
  });

  it('does not invent the key when a bad value is the only patch', () => {
    const merged = mergeSettingsObject({}, { choiceAudioDelayMs: 'soon' as unknown as number });
    expect('choiceAudioDelayMs' in merged).toBe(false);
  });
});
