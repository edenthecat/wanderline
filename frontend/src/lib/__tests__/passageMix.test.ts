import { describe, expect, it } from 'vitest';
import { resolveVolumes, VOLUME_DEFAULTS } from '@wanderline/shared';
import { buildPassageMix } from '../passageMix';

// The mix arithmetic, pinned.
//
// 1.6.0 shipped with every author-set volume applied twice — the
// resolved state multiplied by the same project setting a second time,
// so a 30% music bed played at 9% and 50% indicators at 25%. It reached
// a release because the mix only ever existed inside a running player,
// where nothing asserted a number. These tests are that assertion, and
// the reason the mix is a pure function rather than a component detail.

const context = (volumes: ReturnType<typeof resolveVolumes>, music = true) => ({
  volumes,
  backgroundMusic: music ? { fileId: 'music-1', name: 'dusk.mp3' } : null,
});

const gainOf = (
  plan: ReturnType<typeof buildPassageMix>,
  key: 'voiceover' | 'ambience' | 'music',
) => plan!.layers.find((l) => l.key === key)!.gain;

describe('buildPassageMix — volumes are applied exactly once', () => {
  it("uses the author's music level as-is, not squared", () => {
    // The released fault: 30 resolved, then multiplied by 30/100 again.
    const volumes = resolveVolumes({ backgroundMusicVolume: 30 });
    const plan = buildPassageMix('p1', { voiceover: 'vo-1', sfx: [] }, context(volumes), undefined);
    expect(gainOf(plan, 'music')).toBeCloseTo(0.3, 5); // not 0.09
  });

  it("uses the author's voiceover level as-is, not squared", () => {
    // Voiceover masked the bug in the player: its default is 100 and
    // 1 x 1 = 1. Anything other than 100 exposes it, so assert on that.
    const volumes = resolveVolumes({ voiceoverVolume: 60 });
    const plan = buildPassageMix('p1', { voiceover: 'vo-1', sfx: [] }, context(volumes));
    expect(gainOf(plan, 'voiceover')).toBeCloseTo(0.6, 5); // not 0.36
  });

  it('falls back to the same defaults the player seeds', () => {
    const plan = buildPassageMix(
      'p1',
      { voiceover: 'vo-1', ambience: 'amb-1', sfx: [] },
      context(resolveVolumes({})),
    );
    expect(gainOf(plan, 'voiceover')).toBeCloseTo(VOLUME_DEFAULTS.voiceover / 100, 5);
    expect(gainOf(plan, 'music')).toBeCloseTo(VOLUME_DEFAULTS.backgroundMusic / 100, 5);
  });

  it('reports the percentage behind each gain so the UI can show it', () => {
    const plan = buildPassageMix(
      'p1',
      { voiceover: 'vo-1', sfx: [] },
      context(resolveVolumes({ voiceoverVolume: 40, backgroundMusicVolume: 25 })),
    );
    expect(plan!.layers.map((l) => [l.key, l.volume])).toEqual([
      ['voiceover', 40],
      ['music', 25],
    ]);
  });
});

describe('buildPassageMix — what ends up in the mix', () => {
  const volumes = resolveVolumes({});

  it('layers voiceover, ambience and music together', () => {
    const plan = buildPassageMix(
      'p1',
      { voiceover: 'vo-1', ambience: 'amb-1', sfx: [] },
      context(volumes),
      { 'vo-1': 'her.mp3', 'amb-1': 'rain.mp3' },
    );
    expect(plan!.layers.map((l) => l.key)).toEqual(['voiceover', 'ambience', 'music']);
    expect(plan!.layers.map((l) => l.name)).toEqual(['her.mp3', 'rain.mp3', 'dusk.mp3']);
  });

  it('makes the voiceover the lead and everything else a looping bed', () => {
    const plan = buildPassageMix(
      'p1',
      { voiceover: 'vo-1', ambience: 'amb-1', sfx: [] },
      context(volumes),
    );
    expect(plan!.mix.lead).not.toBeNull();
    expect(plan!.mix.lead!.url).toContain('vo-1');
    expect(plan!.mix.beds).toHaveLength(2);
  });

  // A passage can be ambience-only while its narration is still being
  // recorded; that is exactly when hearing the bed on its own is useful.
  it('plays a passage with no voiceover, with no lead to end it', () => {
    const plan = buildPassageMix('p1', { ambience: 'amb-1', sfx: [] }, context(volumes));
    expect(plan!.mix.lead).toBeNull();
    expect(plan!.mix.beds).toHaveLength(2);
  });

  it('plays without music when the project has none', () => {
    const plan = buildPassageMix('p1', { voiceover: 'vo-1', sfx: [] }, context(volumes, false));
    expect(plan!.layers.map((l) => l.key)).toEqual(['voiceover']);
    expect(plan!.mix.beds).toEqual([]);
  });

  // Choice cues and sfx are not part of the passage's own sound; the
  // player doesn't lay them under the narration either.
  it.each([
    ['nothing attached', undefined],
    ['only choice cues', { choice1: 'c1', sfx: [] }],
    ['only sfx', { sfx: ['s1'] }],
  ])('offers no mix when a node has %s', (_label, nodeAudio) => {
    expect(buildPassageMix('p1', nodeAudio, context(volumes))).toBeNull();
  });
});
