/**
 * Volume resolution — the single definition of how an author's volume
 * settings become an actual gain on an audio element.
 *
 * This lived in three places: the player's `useState` initialisers plus
 * its story-load handler (player-app/src/App.tsx), the editor's
 * `defaultVolume()` (frontend VolumesTab), and — implicitly — every
 * apply site that touched `element.volume`. Keeping them in step was
 * manual, and it failed: the apply sites multiplied the resolved state
 * by `story.settings.<x>Volume / 100` a SECOND time, squaring the
 * author's choice. A 30% music bed played at 9%, 50% indicators at 25%.
 * Voiceover hid the fault because its default is 100 and 1 x 1 = 1.
 *
 * The contract this module exists to state once:
 *
 *   1. Resolution order is per-device override → project setting →
 *      hardcoded fallback. First one present wins; there is no blending.
 *   2. The resolved percentage IS the effective volume. Turn it into a
 *      gain with `volumeToGain` and apply that — nothing else. Any
 *      further multiplication by a setting is the squaring bug.
 */

/**
 * Fallbacks used when neither the listener nor the author has chosen.
 * These are the last link in the resolution chain, so the editor's
 * sliders must show the same numbers the player would apply.
 */
export const VOLUME_DEFAULTS: Readonly<ResolvedVolumes> = {
  voiceover: 100,
  backgroundMusic: 30,
  indicator: 50,
};

/** The author-chosen defaults, as stored in project settings. */
export interface VolumeSettings {
  voiceoverVolume?: number;
  backgroundMusicVolume?: number;
  indicatorVolume?: number;
}

/**
 * A listener's own choices, as the player persists them per device.
 * Key names match the localStorage payload the player writes.
 */
export interface VolumeOverrides {
  voiceover?: number;
  bgMusic?: number;
  indicator?: number;
}

/** Effective volumes, 0-100. */
export interface ResolvedVolumes {
  voiceover: number;
  backgroundMusic: number;
  indicator: number;
}

/**
 * Percentages are what authors and listeners set; anything outside
 * 0-100 is corrupt input (a hand-written PATCH, a mangled localStorage
 * payload) rather than a louder intent. Non-numbers fall through to the
 * next link in the chain instead of being applied — assigning a NaN or
 * a null gain silences an element outright, and `element.volume` throws
 * for anything above 1.
 */
function usable(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/**
 * Resolve the volumes actually in force: per-device override, else the
 * project's author-chosen default, else the fallback.
 *
 * Pass no overrides to get the mix a listener hears on a fresh device —
 * which is also the mix the editor should reproduce, since a listener's
 * per-device preference is theirs, not something the author is authoring.
 */
export function resolveVolumes(
  settings?: VolumeSettings | null,
  overrides?: VolumeOverrides | null,
): ResolvedVolumes {
  const s = settings ?? {};
  const o = overrides ?? {};
  return {
    voiceover: usable(o.voiceover) ?? usable(s.voiceoverVolume) ?? VOLUME_DEFAULTS.voiceover,
    backgroundMusic:
      usable(o.bgMusic) ?? usable(s.backgroundMusicVolume) ?? VOLUME_DEFAULTS.backgroundMusic,
    indicator: usable(o.indicator) ?? usable(s.indicatorVolume) ?? VOLUME_DEFAULTS.indicator,
  };
}

/**
 * The one conversion from a resolved percentage to an
 * `HTMLMediaElement.volume` gain. `state / 100` and nothing else — if
 * you find yourself multiplying by a setting here or at a call site,
 * that is the squaring bug coming back.
 */
export function volumeToGain(volume: number): number {
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return 0;
  return Math.min(1, Math.max(0, volume / 100));
}
