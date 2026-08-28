// What "Play in context" actually plays, worked out as a pure value.
//
// Kept out of the component on purpose: the mix is the part that has to
// be RIGHT. The 1.6.0 fault was a volume applied twice, and it survived
// to a release because the arithmetic only existed inside a running
// player. Here it is a function with inputs and outputs, so a test can
// assert that 30% music is a 0.3 gain and not 0.09.

import { volumeToGain, type ResolvedVolumes } from '@wanderline/shared';
import { audioFileUrl, type AudioAssignments } from '../api/client';
import type { MixLayer, PassageMix } from '../hooks/usePassageMix';

/** The project-wide half of the mix, fetched once per editor tab. */
export interface MixContext {
  /**
   * Volumes already resolved through @wanderline/shared's
   * resolveVolumes — project setting, else fallback. No per-device
   * override: that is a listener's own preference, and the editor is
   * auditioning what the author authored.
   */
  volumes: ResolvedVolumes;
  /**
   * The track the player reaches for first. The build sorts music
   * alphabetically by uploaded name and the player starts its playlist
   * at index 0, so that first track is what a listener hears under this
   * passage on a fresh start. Null when the project has no music.
   */
  backgroundMusic: { fileId: string; name: string } | null;
}

export type MixLayerKey = 'voiceover' | 'ambience' | 'music';

/** One audible layer, with everything the UI needs to name it. */
export interface MixLayerSummary extends MixLayer {
  key: MixLayerKey;
  label: string;
  /** Uploaded filename, when the name lookup knows it. */
  name?: string;
  /** A caveat the author needs to read before trusting this layer. */
  note?: string;
  /** The resolved percentage behind `gain`, shown next to the control
   *  so a wrong mix is visible and not just audible. */
  volume: number;
}

export interface PassageMixPlan {
  /** Ordered for display: voiceover, ambience, music. */
  layers: MixLayerSummary[];
  /** The same layers, shaped for usePassageMix. */
  mix: PassageMix;
}

/**
 * Build the mix for one passage, or null when there is nothing
 * passage-specific to hear.
 *
 * A node with neither voiceover nor ambience is not a passage worth
 * auditioning — background music alone says nothing about it — so the
 * control doesn't appear at all rather than playing a bed on its own.
 */
export function buildPassageMix(
  projectId: string,
  nodeAudio: AudioAssignments[string] | undefined,
  context: MixContext,
  audioNames?: Record<string, string>,
): PassageMixPlan | null {
  const voiceoverId = nodeAudio?.voiceover;
  const ambienceId = nodeAudio?.ambience;
  if (!voiceoverId && !ambienceId) return null;

  const layers: MixLayerSummary[] = [];
  const layer = (
    key: MixLayerKey,
    label: string,
    fileId: string,
    volume: number,
    name?: string,
    note?: string,
  ): MixLayerSummary => ({
    key,
    label,
    name: name ?? audioNames?.[fileId],
    note,
    url: audioFileUrl(projectId, fileId),
    volume,
    // The ONE conversion. `resolved / 100` and nothing else — the
    // release fault was a second multiplication by the same setting
    // sitting downstream of a line like this one.
    gain: volumeToGain(volume),
  });

  if (voiceoverId) {
    layers.push(layer('voiceover', 'Voiceover', voiceoverId, context.volumes.voiceover));
  }
  if (ambienceId) {
    // The player does not play node ambience yet — it precaches the
    // file (see player-app/src/audio-download-order.ts) and never
    // starts it, and there is no ambience volume setting to resolve.
    // Auditioning it under the background-music level is the closest
    // honest approximation: it is the same kind of layer, a looping bed
    // beneath the narration. When the player learns to play ambience,
    // this line is the one that has to agree with it.
    //
    // Until then the divergence is on screen, not just in this comment.
    // A control that claims to be what a listener hears, quietly adding
    // a layer no listener hears, could send an author off re-recording
    // a voiceover to fix masking that does not exist in the build.
    layers.push(
      layer(
        'ambience',
        'Ambience',
        ambienceId,
        context.volumes.backgroundMusic,
        undefined,
        'the generated app does not play node ambience yet',
      ),
    );
  }
  if (context.backgroundMusic) {
    layers.push(
      layer(
        'music',
        'Background music',
        context.backgroundMusic.fileId,
        context.volumes.backgroundMusic,
        context.backgroundMusic.name,
      ),
    );
  }

  const lead = layers.find((l) => l.key === 'voiceover') ?? null;
  return {
    layers,
    mix: {
      lead: lead && { url: lead.url, gain: lead.gain },
      beds: layers.filter((l) => l !== lead).map(({ url, gain }) => ({ url, gain })),
    },
  };
}
