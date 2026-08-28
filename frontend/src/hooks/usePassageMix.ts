// In-context audition — hear a passage the way a listener will, with
// its layers sounding together at the resolved project volumes.
//
// useAudition is deliberately one clip at a time: it answers "is this
// the right take?". It cannot answer "does this voiceover survive the
// music bed under it?", and nothing else in the editor could either.
// That gap is how the squared-volume fault reached a release — the mix
// existed only in the player, so a mix bug was only ever audible there.
//
// Like useAudition, the hook is transport-agnostic: the caller resolves
// URLs and gains and hands over a finished mix. Gains arriving here are
// FINAL (see @wanderline/shared's volumeToGain) — this hook multiplies
// them by nothing, which is the whole point of it existing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { claimAudio, releaseAudio } from '../lib/exclusiveAudio';

export interface MixLayer {
  /** Fully-resolved URL to play. */
  url: string;
  /** Final 0-1 gain, assigned verbatim to `element.volume`. */
  gain: number;
}

export interface PassageMix {
  /**
   * The passage's voiceover. Its end ends the mix — the passage is
   * over when the narration is. Null when the passage has none, in
   * which case the beds play until stopped (or until they all fail).
   */
  lead: MixLayer | null;
  /**
   * Looping layers underneath: the node's ambience and the project's
   * background music. They loop because a passage is auditioned for as
   * long as its narration lasts, not for as long as the bed file does.
   */
  beds: MixLayer[];
}

export interface UsePassageMixResult {
  /** True while the mix is sounding. */
  playing: boolean;
  /** Start the mix, or stop it if it's already playing. */
  toggle: (mix: PassageMix) => void;
  /** Stop every element this hook started (no-op when idle). */
  stop: () => void;
}

/** Start playback without letting a jsdom / SSR stub throw at us.
 *  Real browsers return a promise from play(); jsdom returns undefined,
 *  and a bare `.catch` on that is an uncaught TypeError. */
function startPlayback(el: HTMLAudioElement, onFailure: () => void): void {
  try {
    Promise.resolve(el.play()).catch(onFailure);
  } catch {
    onFailure();
  }
}

export function usePassageMix(): UsePassageMixResult {
  const elementsRef = useRef<HTMLAudioElement[]>([]);
  const [playing, setPlaying] = useState(false);

  // Every start and stop bumps this. Callbacks capture the value they
  // were registered under and no-op once it moves, so a rejection or an
  // error event from a superseded mix can neither stop the current one
  // nor set state after unmount. The same reasoning as useAudition's
  // functional-setState guard, generalised to N elements.
  const epochRef = useRef(0);

  /** Pause and release the current elements. Returns nothing to React. */
  const teardown = useCallback(() => {
    epochRef.current += 1;
    const elements = elementsRef.current;
    // Drop the reference BEFORE pausing: pause() can dispatch events
    // synchronously, and the emptied list means nothing can act on
    // elements we've already released. Releasing them is enough —
    // clearing `src` would make some browsers refetch the page URL and
    // fire a spurious error.
    elementsRef.current = [];
    for (const el of elements) el.pause();
  }, []);

  const stop = useCallback(() => {
    releaseAudio(stop);
    teardown();
    setPlaying(false);
  }, [teardown]);

  const start = useCallback(
    (mix: PassageMix) => {
      const layers: { layer: MixLayer; isLead: boolean }[] = [
        ...(mix.lead ? [{ layer: mix.lead, isLead: true }] : []),
        ...mix.beds.map((layer) => ({ layer, isLead: false })),
      ];
      // Nothing to hear: don't flip into a playing state we'd have no
      // event to leave.
      if (layers.length === 0) return;

      teardown();
      const epoch = epochRef.current;
      // One layer can report failure twice — an 'error' event AND a
      // rejected play() — so count each layer out once, or two reports
      // from one dead file would take the whole mix down with them.
      const failed = layers.map(() => false);
      let live = layers.length;

      const fail = (index: number, isLead: boolean) => {
        if (epochRef.current !== epoch) return;
        if (failed[index]) return;
        failed[index] = true;
        live -= 1;
        // The lead failing leaves nothing to be in context of, and the
        // last bed failing leaves silence. Either way the control must
        // not sit there claiming to play.
        if (isLead || live === 0) stop();
      };

      const elements = layers.map(({ layer, isLead }, index) => {
        const el = new Audio(layer.url);
        el.loop = !isLead;
        // Verbatim. The caller has already resolved this gain; scaling
        // it here by anything is exactly the bug this control exists to
        // make audible.
        el.volume = layer.gain;
        el.addEventListener('error', () => fail(index, isLead));
        if (isLead) {
          el.addEventListener('ended', () => {
            if (epochRef.current === epoch) stop();
          });
        }
        return { el, isLead, index };
      });

      elementsRef.current = elements.map(({ el }) => el);
      // Claim the editor-wide floor: a clip auditioning in another
      // node panel has to stop rather than sound over the mix.
      claimAudio(stop);
      setPlaying(true);
      // Started only after the list is recorded, so a rejection (which
      // lands a microtask later, at the earliest) always finds the state
      // it needs to unwind.
      for (const { el, isLead, index } of elements) {
        startPlayback(el, () => fail(index, isLead));
      }
    },
    [stop, teardown],
  );

  const toggle = useCallback(
    (mix: PassageMix) => {
      if (playing) {
        stop();
        return;
      }
      start(mix);
    },
    [playing, start, stop],
  );

  // Switching passage or tab unmounts the panel; nothing it started
  // may outlive it. teardown() rather than stop() so we don't push a
  // state update into a component that's on its way out — the floor
  // still has to be given up, or the next player would "stop" a
  // component that no longer exists.
  useEffect(() => {
    return () => {
      releaseAudio(stop);
      teardown();
    };
  }, [stop, teardown]);

  return { playing, toggle, stop };
}
