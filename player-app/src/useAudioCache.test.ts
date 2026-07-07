import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAudioCacheIfFull, useAudioCache, type AudioCacheEntry } from './useAudioCache';

// coverage for the audio-cache layer. Real
// HTMLAudioElement loading requires network + a codec-capable jsdom;
// we stub `window.Audio` with a synchronous fake that lets the test
// drive `oncanplaythrough` / `onerror` explicitly. The pure helper
// `evictAudioCacheIfFull` is testable without a hook mount.

// Track every stub instance so tests can fire its lifecycle events.
const audioStubs: FakeAudio[] = [];

class FakeAudio {
  src = '';
  preload = '';
  paused = true;
  ended = false;
  error: MediaError | null = null;
  private _currentTime = 0;
  oncanplaythrough: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url?: string) {
    if (url) this.src = url;
    audioStubs.push(this);
  }
  load() {
    // no-op — tests drive `oncanplaythrough` / `onerror` themselves.
  }
  pause() {
    this.paused = true;
  }
  get currentTime() {
    return this._currentTime;
  }
  set currentTime(v: number) {
    this._currentTime = v;
  }
  fireCanPlayThrough() {
    this.oncanplaythrough?.();
  }
  fireError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  audioStubs.length = 0;
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evictAudioCacheIfFull', () => {
  function entry(pinned = false): AudioCacheEntry {
    // Pinned entries never carry an <audio> in this test; the helper
    // just skips them on the pinned check.
    void pinned;
    return { status: 'loaded', audio: new Audio() as unknown as HTMLAudioElement, retryCount: 0 };
  }

  it('is a no-op when the cache is below the bound', () => {
    const cache = new Map<string, AudioCacheEntry>();
    cache.set('a', entry());
    cache.set('b', entry());
    evictAudioCacheIfFull(cache);
    expect(cache.size).toBe(2);
  });

  it('drops non-pinned entries first when the cache is over the bound', () => {
    const cache = new Map<string, AudioCacheEntry>();
    // Bound is 80 (module constant). Fill with 79 non-pinned + the 2
    // pinned keys to cross it.
    for (let i = 0; i < 79; i++) cache.set(`voice_${i}`, entry());
    cache.set('ind_c1', entry(true));
    cache.set('ind_c2', entry(true));
    evictAudioCacheIfFull(cache);
    // Below the bound after eviction.
    expect(cache.size).toBeLessThan(80);
    // Both pinned keys survived.
    expect(cache.has('ind_c1')).toBe(true);
    expect(cache.has('ind_c2')).toBe(true);
  });
});

describe('useAudioCache — preloadAudio', () => {
  it('resolves on canplaythrough and marks the entry loaded', async () => {
    const { result } = renderHook(() => useAudioCache());
    let resolved = false;
    const promise = act(async () => {
      const p = result.current.preloadAudio('http://example.com/a.mp3', 'a').then(() => {
        resolved = true;
      });
      // Fire the success event on the freshly-created stub.
      audioStubs[audioStubs.length - 1].fireCanPlayThrough();
      await p;
    });
    await promise;
    expect(resolved).toBe(true);
    expect(result.current.isCached('a')).toBe(true);
    expect(result.current.preloadProgress.loaded).toBe(1);
  });

  it('resolves with an error after MAX_RETRIES onerror events', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAudioCache());
      let resolved = false;
      await act(async () => {
        const p = result.current.preloadAudio('http://example.com/a.mp3', 'a').then(() => {
          resolved = true;
        });
        // First attempt errors → schedules retry #1 after 1s.
        audioStubs[0].fireError();
        // Drain all 5 retries: 1s, 2s, 4s, 8s, 16s. Each advance
        // runs the scheduled retry which creates a new stub; the
        // fireError inside the loop then advances the retry chain.
        for (let i = 1; i <= 5; i++) {
          await vi.advanceTimersByTimeAsync(1000 * Math.pow(2, i - 1));
          audioStubs[i].fireError();
        }
        await p;
      });
      expect(resolved).toBe(true);
      // Entry is marked error via preloadProgress.failed++.
      expect(result.current.preloadProgress.failed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('short-circuits when the entry is already loaded', async () => {
    const { result } = renderHook(() => useAudioCache());
    await act(async () => {
      const p = result.current.preloadAudio('http://example.com/a.mp3', 'a');
      audioStubs[0].fireCanPlayThrough();
      await p;
    });
    const stubCountBefore = audioStubs.length;
    await act(async () => {
      await result.current.preloadAudio('http://example.com/a.mp3', 'a');
    });
    // No new Audio was created because we short-circuited on the
    // already-loaded entry.
    expect(audioStubs.length).toBe(stubCountBefore);
  });
});

describe('useAudioCache — getCachedAudio', () => {
  async function primeCache(result: { current: ReturnType<typeof useAudioCache> }) {
    await act(async () => {
      const p = result.current.preloadAudio('http://example.com/a.mp3', 'a');
      audioStubs[0].fireCanPlayThrough();
      await p;
    });
  }

  it('returns the cached element on a matching URL', async () => {
    const hook = renderHook(() => useAudioCache());
    await primeCache(hook.result);
    const cached = audioStubs[0];
    const audio = hook.result.current.getCachedAudio('a', 'http://example.com/a.mp3');
    expect(audio).toBe(cached);
  });

  it('builds a fresh element when the URL drifted', async () => {
    const hook = renderHook(() => useAudioCache());
    await primeCache(hook.result);
    const cached = audioStubs[0];
    const audio = hook.result.current.getCachedAudio('a', 'http://example.com/DIFFERENT.mp3');
    expect(audio).not.toBe(cached);
  });

  it('builds a fresh element when the cached element is currently playing', async () => {
    const hook = renderHook(() => useAudioCache());
    await primeCache(hook.result);
    const cached = audioStubs[0];
    // Simulate playback in progress: not paused, not ended.
    cached.paused = false;
    const audio = hook.result.current.getCachedAudio('a', 'http://example.com/a.mp3');
    expect(audio).not.toBe(cached);
  });

  it('builds a fresh element on a cache miss', () => {
    const hook = renderHook(() => useAudioCache());
    const audio = hook.result.current.getCachedAudio('never-cached', 'http://example.com/x.mp3');
    // A fresh <audio> stub was constructed by getCachedAudio's
    // buildFresh helper.
    expect(audio).toBeDefined();
    expect(audioStubs.some((s) => s.src === 'http://example.com/x.mp3')).toBe(true);
  });
});

describe('useAudioCache — retryFailedAudio', () => {
  it('resets the failed counter and re-attempts', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAudioCache());
      // Force one preload to fail all retries.
      await act(async () => {
        const p = result.current.preloadAudio('http://example.com/a.mp3', 'a');
        audioStubs[0].fireError();
        for (let i = 1; i <= 5; i++) {
          await vi.advanceTimersByTimeAsync(1000 * Math.pow(2, i - 1));
          audioStubs[i].fireError();
        }
        await p;
      });
      expect(result.current.preloadProgress.failed).toBe(1);
      // Retry: same key/url. failed counter decrements immediately.
      act(() => result.current.retryFailedAudio('a', 'http://example.com/a.mp3'));
      expect(result.current.preloadProgress.failed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useAudioCache — resetPreloadProgress', () => {
  it('resets loaded/failed to zero and sets total', () => {
    const { result } = renderHook(() => useAudioCache());
    act(() => result.current.resetPreloadProgress(42));
    expect(result.current.preloadProgress).toEqual({ loaded: 0, total: 42, failed: 0 });
  });
});
