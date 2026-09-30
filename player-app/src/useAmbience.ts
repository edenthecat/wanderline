// Per-passage ambience: a looping bed under the narration.
//
// Authors could always attach an ambience file to a passage, and builds
// shipped it, but nothing in the player ever started it, so it was
// silent in every preview and every build.
//
// The bed belongs to the place, not the passage, so it is driven by
// which FILE should be playing rather than by node changes:
//
//   - the next passage has the same file: it carries on, uninterrupted
//     (restarting the loop on every passage would be audible);
//   - a different file: the old one fades out while the new one fades
//     in, over AMBIENCE_FADE_MS;
//   - no file: the current one fades out.
//
// Like background music, it is independent of narration pause: pausing
// the voice doesn't silence the room. It stops when the caller passes
// null (the instructions screen, the ending) or on unmount.
//
// iOS Safari ignores writes to HTMLMediaElement.volume. There the fades
// degrade to a cut and the level follows the device volume, which is
// the same limitation background music already has.

import { useEffect, useRef } from 'react';

export const AMBIENCE_FADE_MS = 1500;
const FADE_STEP_MS = 50;
const PLAY_MAX_RETRIES = 3;
const PLAY_RETRY_BASE_MS = 1000;

export interface UseAmbienceOptions {
  /** Full URL of the ambience that should be playing now, or null. */
  url: string | null;
  /** Target level, 0..1. */
  volume: number;
  /** Hands back a ready-to-play element for a URL (the audio cache). */
  getElement: (url: string) => HTMLAudioElement;
}

interface Fade {
  timer: ReturnType<typeof setInterval>;
}

export function useAmbience({ url, volume, getElement }: UseAmbienceOptions): void {
  const currentRef = useRef<{ url: string; el: HTMLAudioElement; start: () => void } | null>(null);
  const fadesRef = useRef(new Map<HTMLAudioElement, Fade>());
  // Read on every fade step so a slider moved mid-fade lands where the
  // listener put it rather than where it was when the fade began.
  const volumeRef = useRef(volume);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const getElementRef = useRef(getElement);
  getElementRef.current = getElement;

  const cancelFade = (el: HTMLAudioElement) => {
    const fade = fadesRef.current.get(el);
    if (fade) {
      clearInterval(fade.timer);
      fadesRef.current.delete(el);
    }
  };

  /** Ramp `el` from its current level to `target()` over the fade time. */
  const fade = (el: HTMLAudioElement, target: () => number, onDone?: () => void) => {
    cancelFade(el);
    const from = el.volume;
    const steps = Math.max(1, Math.round(AMBIENCE_FADE_MS / FADE_STEP_MS));
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      const t = step / steps;
      el.volume = clamp01(from + (target() - from) * t);
      if (step >= steps) {
        cancelFade(el);
        onDone?.();
      }
    }, FADE_STEP_MS);
    fadesRef.current.set(el, { timer });
  };

  useEffect(() => {
    const current = currentRef.current;
    if (current?.url === url) return;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (current) {
      const leaving = current.el;
      fade(
        leaving,
        () => 0,
        () => leaving.pause(),
      );
      currentRef.current = null;
    }

    if (url) {
      const el = getElementRef.current(url);
      // Leaving a file and coming straight back hands us a fresh element
      // (the cache won't reuse one that's still playing its fade-out),
      // but guard anyway so no fade is left driving an element we own.
      cancelFade(el);
      el.loop = true;
      el.volume = 0;
      // A bed that fails to start stays silent for every passage that
      // shares it (the file doesn't change, so nothing here runs again),
      // so retry a transient refusal a few times with backoff, as
      // background music does. Give up quietly once the bed has changed.
      let attempt = 0;
      const start = () => {
        // A bed left and returned to before an earlier refusal settled
        // can come back as the same cached element with its own retry
        // chain; only the chain that still owns it may keep trying.
        if (currentRef.current?.el !== el || currentRef.current.start !== start) return;
        el.play().catch(() => {
          if (currentRef.current?.start !== start || attempt >= PLAY_MAX_RETRIES) return;
          attempt += 1;
          retryTimerRef.current = setTimeout(start, PLAY_RETRY_BASE_MS * attempt);
        });
      };
      currentRef.current = { url, el, start };
      start();
      fade(el, () => volumeRef.current);
    }
    // fade/cancelFade only touch refs.
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    volumeRef.current = clamp01(volume);
    const current = currentRef.current;
    // Mid-fade-in, the fade reads volumeRef itself.
    if (current && !fadesRef.current.has(current.el)) current.el.volume = volumeRef.current;
  }, [volume]);

  useEffect(() => {
    const fades = fadesRef.current;
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      for (const [el, f] of fades) {
        clearInterval(f.timer);
        el.pause();
      }
      fades.clear();
      currentRef.current?.el.pause();
      currentRef.current = null;
    };
  }, []);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
