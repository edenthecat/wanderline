// audio audition — hear an uploaded clip without leaving the editor.
// One Audio element per hook instance, one "now-playing" id at a
// time; toggling to another id auto-stops the previous. The caller
// passes a fully-resolved URL to `toggle(id, url)` — the hook itself
// is transport-agnostic and doesn't know how the URL was built.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAuditionResult {
  /** id currently playing, or null. */
  playingId: string | null;
  /** Toggle: play `id` if not currently playing, otherwise pause. */
  toggle: (id: string, url: string) => void;
  /** Stop whatever's playing (does nothing if nothing is). */
  stop: () => void;
}

export function useAudition(): UseAuditionResult {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  // Lazy-init the Audio element on first play — creating it eagerly
  // in a ref initializer would run in SSR / test environments where
  // Audio isn't defined.
  //
  // The event listeners are guarded by `audioRef.current === a` so an
  // event that fires after we've released the audio element (e.g.
  // after unmount) can't call setPlayingId on an unmounted component.
  //
  // We do NOT listen for 'pause' any more: browsers dispatch it
  // asynchronously after our own audio.pause() call, and it can land
  // AFTER a fresh setPlayingId(newId) from the follow-up toggle —
  // which would then incorrectly clear newId. Every place we call
  // pause() also synchronously updates playingId (stop() clears it,
  // toggle() replaces it with the new id), so the listener isn't
  // needed to reconcile state.
  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (audioRef.current) return audioRef.current;
    const a = new Audio();
    a.preload = 'none';
    a.addEventListener('ended', () => {
      if (audioRef.current === a) setPlayingId(null);
    });
    a.addEventListener('error', () => {
      if (audioRef.current === a) setPlayingId(null);
    });
    audioRef.current = a;
    return a;
  }, []);

  const stop = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.pause();
    // Rewind so the next play() from the same id starts at 0.
    try {
      a.currentTime = 0;
    } catch {
      // Some browsers throw on currentTime= before any media loaded.
    }
    setPlayingId(null);
  }, []);

  const toggle = useCallback(
    (id: string, url: string) => {
      const a = ensureAudio();
      if (playingId === id) {
        stop();
        return;
      }
      a.pause();
      a.src = url;
      // Same guard as in stop() — some browsers throw on currentTime=
      // before any media has loaded.
      try {
        a.currentTime = 0;
      } catch {
        // ignore
      }
      setPlayingId(id);
      // play() returns a promise; if it rejects (autoplay policy,
      // network error, unsupported codec) reset state so the UI
      // doesn't look like it's still playing. Guard with a
      // functional setState so a stale rejection from an earlier
      // play() can't clear the state for a click that succeeded
      // afterwards.
      a.play().catch(() => {
        setPlayingId((current) => (current === id ? null : current));
      });
    },
    [ensureAudio, playingId, stop],
  );

  // Tear down when the owning component unmounts so we don't leak an
  // Audio element or leave audio playing after navigation.
  //
  // Null the ref BEFORE calling pause() — the event listeners
  // installed in ensureAudio() gate their setPlayingId on
  // audioRef.current === a, so nulling first makes the pause /
  // error event that unmount cleanup can trigger a no-op instead
  // of a state update on an unmounted component.
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      audioRef.current = null;
      if (a) a.pause();
    };
  }, []);

  return { playingId, toggle, stop };
}
