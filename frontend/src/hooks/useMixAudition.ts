// Audition a passage as the listener will hear it: the voiceover over its
// looping ambience, with sound effects landing where they're timed.
//
// The single-clip audition (useAudition) answers "is this the right
// take?". This answers "does it sit right together?" — which until now
// needed a full preview, and even then couldn't be heard because the
// player never played ambience.
//
// Timing follows the player (player-app/src/passage-sfx.ts): an effect
// with no offset plays as the passage starts; one with an offset (0
// included) plays that far into the narration, or that long after
// starting on a passage with no narration. Anything timed past the narration plays when it
// ends. The mix stops by itself a moment after the narration ends (or
// after the last effect, with neither narration nor ambience); with only
// ambience it loops until stopped.
//
// play() must be called straight from the click, with nothing awaited
// first: Safari only lets an element play from a user gesture, so every
// element is created and started (effects muted, then parked) inside it.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface MixSfx {
  url: string;
  offsetMs?: number;
}

export interface MixSpec {
  voiceUrl?: string;
  ambienceUrl?: string;
  sfx: MixSfx[];
  /** 0..1 */
  voiceVolume: number;
  /** 0..1, ambience and sound effects */
  ambienceVolume: number;
}

/** How long the mix carries on after the last thing it had to play. */
export const MIX_TAIL_MS = 1500;

export interface UseMixAuditionResult {
  playing: boolean;
  play: (spec: MixSpec) => void;
  stop: () => void;
}

const isUntimed = (fx: MixSfx) =>
  !(typeof fx.offsetMs === 'number' && Number.isFinite(fx.offsetMs) && fx.offsetMs >= 0);

const offsetOf = (fx: MixSfx) =>
  typeof fx.offsetMs === 'number' && Number.isFinite(fx.offsetMs) && fx.offsetMs > 0
    ? fx.offsetMs
    : 0;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function useMixAudition(): UseMixAuditionResult {
  const [playing, setPlaying] = useState(false);
  // Everything the current mix owns, so stop() can tear all of it down.
  const elementsRef = useRef<HTMLAudioElement[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current += 1;
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    for (const el of elementsRef.current) {
      el.onended = null;
      el.ontimeupdate = null;
      el.onerror = null;
      el.pause();
    }
    elementsRef.current = [];
    setPlaying(false);
  }, []);

  const play = useCallback(
    (spec: MixSpec) => {
      stop();
      const run = runRef.current;
      const live = () => runRef.current === run;
      const own = (el: HTMLAudioElement) => {
        elementsRef.current.push(el);
        return el;
      };
      const finishSoon = () => {
        timersRef.current.push(setTimeout(() => live() && stop(), MIX_TAIL_MS));
      };
      const ambienceVolume = clamp01(spec.ambienceVolume);

      // Effects: created and started muted now, inside the gesture, then
      // parked until they're due.
      const played = new Set<number>();
      let sounding = 0;
      const effects = spec.sfx.map((fx, i) => {
        const el = own(new Audio(fx.url));
        el.volume = ambienceVolume;
        el.muted = true;
        el.play()
          .then(() => {
            if (!played.has(i)) {
              el.pause();
              el.currentTime = 0;
            }
          })
          .catch(() => {});
        return el;
      });
      // Done once there's nothing left to come: the narration has ended
      // (or, with neither narration nor ambience, every effect has fired)
      // and no effect is still ringing. A late effect gets to finish
      // rather than being cut off by the tail.
      const onlyEffects = !spec.voiceUrl && !spec.ambienceUrl;
      let voiceDone = false;
      const maybeFinish = () => {
        if (!live() || sounding > 0) return;
        if (voiceDone || (onlyEffects && played.size === spec.sfx.length)) finishSoon();
      };
      // `elapsedMs` null: the untimed ones, as the passage starts.
      const fireDue = (elapsedMs: number | null) => {
        spec.sfx.forEach((fx, i) => {
          if (played.has(i)) return;
          if (elapsedMs === null ? !isUntimed(fx) : elapsedMs < offsetOf(fx)) return;
          played.add(i);
          const el = effects[i];
          el.muted = false;
          el.currentTime = 0;
          sounding += 1;
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            sounding -= 1;
            maybeFinish();
          };
          // An effect that won't load or play must not hold the mix open.
          el.onended = settle;
          el.onerror = settle;
          el.play().catch(settle);
        });
      };

      // As the passage starts, not when the narration does.
      fireDue(null);

      if (spec.ambienceUrl) {
        const bed = own(new Audio(spec.ambienceUrl));
        bed.loop = true;
        bed.volume = ambienceVolume;
        bed.play().catch(() => {});
      }

      if (spec.voiceUrl) {
        const voice = own(new Audio(spec.voiceUrl));
        voice.volume = clamp01(spec.voiceVolume);
        voice.ontimeupdate = () => {
          if (live()) fireDue(voice.currentTime * 1000);
        };
        voice.onended = () => {
          if (!live()) return;
          voiceDone = true;
          fireDue(Number.POSITIVE_INFINITY);
          maybeFinish();
        };
        // A voiceover that won't load would otherwise leave the bed
        // looping with nothing to end it.
        voice.onerror = () => live() && stop();
        voice
          .play()
          .then(() => live() && fireDue(0))
          .catch(() => live() && stop());
      } else {
        for (const fx of spec.sfx) {
          timersRef.current.push(setTimeout(() => live() && fireDue(offsetOf(fx)), offsetOf(fx)));
        }
      }
      setPlaying(true);
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { playing, play, stop };
}
