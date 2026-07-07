// the audio cache layer, extracted from App.tsx.
//
// The player preloads voiceover + choice-indicator audio ahead of the
// user reaching the node (partly for perceived responsiveness, partly
// because retrying a stalled load mid-playback surfaces as the
// "reconnect" pattern that flooded logs and interrupted the
// story). This hook owns:
//
//   - `audioCacheRef` — the Map<key, entry> that pins live <audio>
//     elements + decoded buffers so subsequent visits reuse them.
//   - `preloadAudio(url, key)` — fire-and-forget preload with retry-
//     with-exponential-backoff (1s / 2s / 4s / 8s / 16s, up to 5 tries).
//   - `getCachedAudio(key, url)` — hand the caller a ready-to-play
//     <audio> element. Rewinds the cached instance when safe;
//     builds a fresh element on cache miss, URL drift, error state,
//     rewind failure, or when the cached element is currently
//     playing (overlap → clone instead of stomp).
//   - `retryFailedAudio(key, url)` — reset the retry counter on a
//     specific failed entry and re-attempt.
//   - `isCached(key)` — cheap presence check for the "already
//     preloading?" gate that fires per node visit.
//   - `preloadProgress` — { loaded, total, failed } for the
//     spinner / retry UI. Reset via `resetPreloadProgress(total)`.
//
// The cache is bounded (AUDIO_CACHE_MAX_ENTRIES) — long stories
// would otherwise pin every preloaded element until page unload.
// Choice indicators (ind_c1 / ind_c2) are pinned across evictions
// because dropping them re-triggers the reconnect pattern
// on the next choice-list render.

import { useCallback, useRef, useState } from 'react';

export interface AudioCacheEntry {
  status: 'loading' | 'loaded' | 'error';
  audio: HTMLAudioElement | null;
  retryCount: number;
  lastError?: string;
}

export interface PreloadProgress {
  loaded: number;
  total: number;
  failed: number;
}

const AUDIO_CACHE_MAX_ENTRIES = 80;
const PINNED_CACHE_KEYS = new Set<string>(['ind_c1', 'ind_c2']);
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Drop the oldest non-pinned entries until the cache is below the
 * bound. Pinned keys (indicators) survive eviction because they're
 * hot across the whole session and dropping them re-triggers the
 * reconnect pattern.
 */
export function evictAudioCacheIfFull(cache: Map<string, AudioCacheEntry>): void {
  if (cache.size < AUDIO_CACHE_MAX_ENTRIES) return;
  for (const key of cache.keys()) {
    if (PINNED_CACHE_KEYS.has(key)) continue;
    const entry = cache.get(key);
    if (entry?.audio) {
      try {
        entry.audio.pause();
        entry.audio.src = '';
      } catch {
        // Best-effort teardown; ignore.
      }
    }
    cache.delete(key);
    if (cache.size < AUDIO_CACHE_MAX_ENTRIES) return;
  }
}

export interface UseAudioCacheResult {
  /** Fire-and-forget preload with retry-with-exponential-backoff.
   * Resolves after either loaded, permanently failed, or already
   * cached — never rejects. Skip via `isCached(key)` in hot paths. */
  preloadAudio: (url: string, key: string) => Promise<void>;
  /** Return a ready-to-play <audio> element for `key`/`url`. Rewinds
   * the cached instance when safe; builds a fresh element on cache
   * miss, URL drift, error state, rewind failure, or when the
   * cached element is currently playing. */
  getCachedAudio: (key: string, url: string) => HTMLAudioElement;
  /** Reset the retry counter on a failed entry and re-attempt the
   * preload. No-op if the entry isn't in the `error` state. */
  retryFailedAudio: (key: string, url: string) => void;
  /** Cheap presence check for the "already preloading?" gate that
   * fires per node visit. Doesn't inspect status — a `loading`
   * entry counts as cached. */
  isCached: (key: string) => boolean;
  /** UI-facing preload progress. Written by `preloadAudio` on load
   * / fail and by `retryFailedAudio` to decrement `failed`. */
  preloadProgress: PreloadProgress;
  /** Reset progress with a fresh `total`. Called at the start of a
   * critical-audio preload sweep. */
  resetPreloadProgress: (total: number) => void;
  /** Escape hatch for the follow-up playback layer (voiceover /
   * bgm / indicators) — those callers need direct read access to
   * poke at individual entries (e.g. `entry.audio.pause()` on tab-
   * hide). Prefer the wrapper methods above where possible. */
  cacheRef: React.MutableRefObject<Map<string, AudioCacheEntry>>;
}

export function useAudioCache(): UseAudioCacheResult {
  const audioCacheRef = useRef<Map<string, AudioCacheEntry>>(new Map());
  // Preload progress is exposed for a spinner / retry UI. Kept in
  // React state (not a ref) so components that render off it can
  // re-render when a preload completes.
  const [preloadProgress, setPreloadProgress] = useState<PreloadProgress>({
    loaded: 0,
    total: 0,
    failed: 0,
  });

  const preloadAudio = useCallback((url: string, key: string): Promise<void> => {
    return new Promise((resolve) => {
      const cache = audioCacheRef.current;
      const existing = cache.get(key);
      if (existing?.status === 'loaded') {
        resolve();
        return;
      }
      evictAudioCacheIfFull(cache);

      const entry: AudioCacheEntry = {
        status: 'loading',
        audio: null,
        retryCount: existing?.retryCount ?? 0,
      };
      cache.set(key, entry);

      const attemptLoad = (retryNum: number) => {
        const audio = new Audio();
        audio.preload = 'auto';

        audio.oncanplaythrough = () => {
          const current = cache.get(key);
          if (current) {
            current.status = 'loaded';
            current.audio = audio;
            current.retryCount = retryNum;
          }
          setPreloadProgress((prev) => ({ ...prev, loaded: prev.loaded + 1 }));
          resolve();
        };

        audio.onerror = () => {
          if (retryNum < MAX_RETRIES) {
            // Exponential backoff: 1s, 2s, 4s, 8s, 16s
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retryNum);
            setTimeout(() => attemptLoad(retryNum + 1), delay);
          } else {
            const current = cache.get(key);
            if (current) {
              current.status = 'error';
              current.lastError = 'Failed to load after ' + MAX_RETRIES + ' attempts';
            }
            setPreloadProgress((prev) => ({ ...prev, failed: prev.failed + 1 }));
            resolve(); // Resolve anyway so we don't block everything
          }
        };

        audio.src = url;
        // Explicit load() so the browser starts fetching immediately
        // after the src assignment — some engines defer the fetch
        // until an event listener is attached, which we don't do
        // here (the oncanplaythrough / onerror pattern above is the
        // only signal we need).
        audio.load();
      };

      attemptLoad(entry.retryCount);
    });
  }, []);

  const retryFailedAudio = useCallback(
    (key: string, url: string) => {
      const cache = audioCacheRef.current;
      const entry = cache.get(key);
      if (!entry || entry.status !== 'error') return;
      entry.retryCount = 0;
      entry.status = 'loading';
      setPreloadProgress((prev) => ({ ...prev, failed: Math.max(0, prev.failed - 1) }));
      preloadAudio(url, key);
    },
    [preloadAudio],
  );

  const getCachedAudio = useCallback((key: string, url: string): HTMLAudioElement => {
    const cache = audioCacheRef.current;
    const entry = cache.get(key);
    const buildFresh = () => {
      const a = new Audio(url);
      a.preload = 'auto';
      return a;
    };

    if (entry?.status !== 'loaded' || !entry.audio) return buildFresh();
    const cached = entry.audio;

    // Guard 1: URL changed (cache key reuse with a new file).
    // HTMLAudioElement.src always resolves to an absolute URL, but
    // callers can pass either absolute or relative. Compare via the
    // URL constructor (with window.location as the base for relative)
    // so 'audio/abc.mp3' vs 'http://host/audio/abc.mp3' match. A
    // malformed url falls through to the inequality path → buildFresh.
    if (cached.src) {
      let cachedHref = cached.src;
      let urlHref = url;
      try {
        cachedHref = new URL(cached.src, window.location.href).href;
        urlHref = new URL(url, window.location.href).href;
      } catch {
        // Leave hrefs as-is; the inequality will fall through.
      }
      if (cachedHref !== urlHref) return buildFresh();
    }
    // Guard 2: element entered an errored state.
    if (cached.error) return buildFresh();
    const isBusy = !cached.paused && !cached.ended;
    // Genuine overlap — clone so the live playback isn't stomped.
    if (isBusy) return buildFresh();
    // Guard 3: rewind may throw on evicted-buffer elements.
    try {
      cached.currentTime = 0;
    } catch {
      return buildFresh();
    }
    return cached;
  }, []);

  const isCached = useCallback((key: string): boolean => {
    return audioCacheRef.current.has(key);
  }, []);

  const resetPreloadProgress = useCallback((total: number) => {
    setPreloadProgress({ loaded: 0, total, failed: 0 });
  }, []);

  return {
    preloadAudio,
    getCachedAudio,
    retryFailedAudio,
    isCached,
    preloadProgress,
    resetPreloadProgress,
    cacheRef: audioCacheRef,
  };
}
