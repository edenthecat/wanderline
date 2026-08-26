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

// A media element that stops receiving bytes mid-fetch fires NEITHER
// `canplaythrough` NOR `error` — it just sits in readyState 0/1
// forever. Before this timeout existed, a dropped connection or a
// captive portal left the preload promise permanently unsettled, the
// entry stuck at status:'loading', and the caller's spinner spinning
// for the rest of the session. Bound every attempt so a stall is
// converted into a normal retry.
//
// 20s is comfortably past a slow-3G fetch of a typical voiceover clip
// while still leaving the 5-step backoff ladder inside a listener's
// patience.
const STALL_TIMEOUT_MS = 20_000;

// iOS Safari refuses to buffer a media element that no user gesture
// has touched: `preload='auto'` is downgraded and `canplaythrough`
// never fires, no matter how long we wait. So we don't rely on the
// element to do the downloading — we pull the bytes with fetch()
// first (not gesture-gated, and it populates the service-worker
// audio cache on the way past), then hand the element a URL that is
// already warm. The element load becomes a formality that resolves
// from cache.
//
// If the fetch can't be used — cross-origin redirect without CORS,
// no service worker, a browser that rejects the request — we fall
// back to the original element-driven path, which still works
// everywhere except iOS. Degrading to "no worse than before" matters
// more here than purity: this runs for every audio file in a story.
const FETCH_WARM_TIMEOUT_MS = 20_000;

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

// Session-scoped latch. Set once we learn that this deployment serves
// audio via a redirect whose bytes nothing retains, at which point
// every further warm is a pure waste of transfer. Costs us one
// redundant file before it trips, rather than one per file.
let warmingIsWasteful = false;

/** Exported for tests; resets the session latch between cases. */
export function resetWarmHeuristicForTests(): void {
  warmingIsWasteful = false;
}

/**
 * Pull an audio URL through fetch() so the bytes are already local
 * before any media element asks for them.
 *
 * This exists for iOS. Safari there will not buffer a media element
 * that no user gesture has touched, so `canplaythrough` never fires on
 * a cold preload and the element alone can never download a story
 * ahead of playback. fetch() has no such restriction.
 *
 * @returns true only when the bytes were both read AND retained
 * somewhere the element will subsequently read from. Returning false
 * means the caller must let the element do the transfer itself.
 */
async function warmAudioUrl(url: string): Promise<boolean> {
  if (typeof fetch !== 'function') return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_WARM_TIMEOUT_MS) : null;
  try {
    const response = await fetch(url, { credentials: 'same-origin', signal: controller?.signal });
    // An opaque response means we crossed an origin we can't read:
    // status 0, body sealed, nothing cached.
    if (!response.ok || response.type === 'opaque') return false;
    // Drain the body — without this the transfer may never complete
    // and nothing reaches any cache.
    await response.arrayBuffer();

    if (!response.redirected) {
      // A direct same-origin response: an exported build on static
      // hosting, or the backend streaming audio itself. Both send
      // ordinary cache headers, so the HTTP cache now holds this and
      // the element will be served from it.
      return true;
    }

    // Redirected means the signed-URL path, whose 307 is marked
    // `Cache-Control: no-store` precisely because a signed URL expires
    // and must not be replayed. The HTTP cache keeps nothing, so the
    // only thing that can retain these bytes is the service worker's
    // audio cache — and only when a worker is actually controlling
    // this page.
    if (navigator.serviceWorker?.controller) return true;

    // Nothing kept it. Stop warming for the rest of the session so we
    // don't pay this twice on every remaining file; see the runbook
    // note about signed URLs existing to keep GCS egress off Cloud
    // Run's meter.
    warmingIsWasteful = true;
    return false;
  } catch {
    // Offline, CORS-blocked, or aborted. The element decides the real
    // outcome for this file.
    return false;
  } finally {
    if (timer) clearTimeout(timer);
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
        // Start a fresh ladder rather than inheriting a spent count.
        // Seeding attemptLoad() with an exhausted retryCount (5) made
        // it fall straight to the failure branch without issuing a
        // single network request. App.tsx gates re-preloads on
        // isCached(), so a genuinely-failed entry stays in the map and
        // isn't re-attempted through here anyway; retryFailedAudio()
        // is the explicit way back in.
        retryCount: 0,
      };
      cache.set(key, entry);

      let settled = false;

      // The entry can be evicted while its load is still in flight —
      // evictAudioCacheIfFull walks insertion order and doesn't skip
      // status:'loading'. So re-read from the map on settle rather
      // than closing over `entry`, and resolve unconditionally: a
      // vanished entry must not hang the caller's Promise.all.
      const finish = (apply: (current: AudioCacheEntry) => void, ok: boolean) => {
        if (settled) return;
        settled = true;
        const current = cache.get(key);
        if (current) apply(current);
        setPreloadProgress((prev) =>
          ok ? { ...prev, loaded: prev.loaded + 1 } : { ...prev, failed: prev.failed + 1 },
        );
        resolve();
      };

      const attemptLoad = (retryNum: number) => {
        const audio = new Audio();
        audio.preload = 'auto';

        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        let attemptDone = false;

        const teardown = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = null;
          audio.oncanplaythrough = null;
          audio.onerror = null;
        };

        const succeed = () => {
          if (attemptDone) return;
          attemptDone = true;
          teardown();
          finish((current) => {
            current.status = 'loaded';
            current.audio = audio;
            current.retryCount = retryNum;
          }, true);
        };

        // Both failure modes — the error event and the stall timeout —
        // funnel here so the retry ladder behaves identically for a
        // hard 404 and a connection that simply stopped delivering.
        const giveUpOrRetry = (reason: string) => {
          if (attemptDone) return;
          attemptDone = true;
          teardown();
          if (retryNum < MAX_RETRIES) {
            // Exponential backoff: 1s, 2s, 4s, 8s, 16s
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retryNum);
            setTimeout(() => attemptLoad(retryNum + 1), delay);
            return;
          }
          finish((current) => {
            current.status = 'error';
            current.lastError = `Failed to load after ${MAX_RETRIES} attempts (${reason})`;
          }, false);
        };

        audio.oncanplaythrough = succeed;
        audio.onerror = () => giveUpOrRetry('error');
        stallTimer = setTimeout(() => giveUpOrRetry('stalled'), STALL_TIMEOUT_MS);

        // preload='none' up front so assigning src does NOT start a
        // network fetch. The URL still lands on the element
        // immediately, which getCachedAudio relies on to detect drift;
        // only the transfer is deferred.
        audio.preload = 'none';
        audio.src = url;

        const startElementLoad = () => {
          if (attemptDone) return;
          audio.preload = 'auto';
          // Explicit load() so the browser starts fetching immediately
          // — some engines defer until an event listener is attached,
          // which we don't do here (the oncanplaythrough / onerror
          // pattern above is the only signal we need).
          audio.load();
        };

        // Warming with fetch() is what makes a cold preload possible on
        // iOS, where Safari refuses to buffer an element no user
        // gesture has touched and `canplaythrough` therefore never
        // arrives.
        //
        // Whether it's worth doing depends on how this build is
        // served, which we can't know until we've tried once:
        //
        //  - An exported build on static hosting serves ./audio/*
        //    directly with ordinary cache headers. Warming is free and
        //    the element is then served from the HTTP cache.
        //  - The hosted signed-URL path 307s to storage with
        //    `Cache-Control: no-store`, so unless a service worker
        //    catches the bytes they're discarded and the element has to
        //    transfer the file a second time.
        //
        // warmAudioUrl decides from the actual response and latches
        // `warmingIsWasteful` when it finds the second shape with no
        // worker, so at most one file pays for the discovery.
        if (!warmingIsWasteful) {
          void warmAudioUrl(url).then((retained) => {
            if (attemptDone) return;
            if (retained) {
              // Bytes are local. The element hasn't transferred
              // anything and doesn't need to — playback reads from
              // whichever cache holds them.
              succeed();
              return;
            }
            // Not retained (offline, CORS-blocked, or a no-store
            // redirect). Media elements aren't subject to CORS, so let
            // the element try the same URL — it usually succeeds.
            startElementLoad();
          });
        } else {
          startElementLoad();
        }
      };

      attemptLoad(0);
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
