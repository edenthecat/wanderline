// audio audition — hear an uploaded clip without leaving the editor
// (DEV-168). One Audio element per hook instance, one "now-playing"
// id at a time; toggling to another id auto-stops the previous. The
// caller supplies a URL builder so the same hook works from
// AudioTab (streams the file by id) and, later, from anywhere else
// that has an audio-file reference.

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
  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (audioRef.current) return audioRef.current;
    const a = new Audio();
    a.preload = 'none';
    a.addEventListener('ended', () => setPlayingId(null));
    a.addEventListener('error', () => setPlayingId(null));
    a.addEventListener('pause', () => {
      // The 'pause' event fires on end-of-track too (browsers pause
      // before emitting 'ended'). Only clear the playingId when the
      // pause is a real, mid-track stop — i.e. the media hasn't
      // reached its end. This avoids double-firing setPlayingId.
      if (!a.ended) setPlayingId(null);
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
      a.currentTime = 0;
      setPlayingId(id);
      // play() returns a promise; if it rejects (autoplay policy,
      // network error, unsupported codec) reset state so the UI
      // doesn't look like it's still playing.
      a.play().catch(() => setPlayingId(null));
    },
    [ensureAudio, playingId, stop],
  );

  // Tear down when the owning component unmounts so we don't leak an
  // Audio element or leave audio playing after navigation.
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) a.pause();
      audioRef.current = null;
    };
  }, []);

  return { playingId, toggle, stop };
}
