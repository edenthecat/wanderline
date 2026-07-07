// Tests for the offline-support hook. Drives the state machine
// directly by dispatching the same browser events / SW messages
// the hook listens for and asserts the resulting state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOfflineSupport } from './useOfflineSupport';

// ---- Service-worker stub --------------------------------------------------
//
// The hook reads navigator.serviceWorker.ready (a Promise<ServiceWorkerRegistration>)
// and subscribes to 'message' events on navigator.serviceWorker. We stub
// both so we can fire synthetic messages from the test.

interface SwStub {
  fire(data: unknown): void;
  setActive(active: { postMessage: (msg: unknown) => void } | null): void;
  reset(): void;
}

function installServiceWorkerStub(): SwStub {
  const listeners = new Set<(e: MessageEvent) => void>();
  let active: { postMessage: (msg: unknown) => void } | null = {
    postMessage: vi.fn(),
  };
  const sw = {
    ready: Promise.resolve({
      get active() {
        return active;
      },
    }),
    addEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
      if (type !== 'message') return;
      listeners.add(cb as (e: MessageEvent) => void);
    },
    removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
      if (type !== 'message') return;
      listeners.delete(cb as (e: MessageEvent) => void);
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: sw,
  });
  return {
    fire(data) {
      const event = { data } as MessageEvent;
      for (const cb of listeners) cb(event);
    },
    setActive(a) {
      active = a;
    },
    reset() {
      listeners.clear();
      active = { postMessage: vi.fn() };
    },
  };
}

function uninstallServiceWorker() {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
}

const ORIGINAL_ONLINE = Object.getOwnPropertyDescriptor(navigator, 'onLine');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  uninstallServiceWorker();
  // Restore navigator.onLine to whatever the runtime default is so
  // tests don't leak state across files.
  if (ORIGINAL_ONLINE) Object.defineProperty(navigator, 'onLine', ORIGINAL_ONLINE);
  else Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('useOfflineSupport — online/offline tracking', () => {
  it('reflects navigator.onLine on mount', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const { result } = renderHook(() => useOfflineSupport());
    expect(result.current.online).toBe(false);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  it('updates on online/offline window events', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    const { result } = renderHook(() => useOfflineSupport());
    expect(result.current.online).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current.online).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current.online).toBe(true);
  });
});

describe('useOfflineSupport — precache lifecycle', () => {
  it('moves to "downloading" when downloadForOffline is called, then "done" on PRECACHE_COMPLETE', async () => {
    const sw = installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());

    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3', './audio/b.mp3']);
    });
    expect(result.current.precacheStatus).toBe('downloading');
    expect(result.current.precacheProgress.total).toBe(2);

    // Two progress messages then a terminal complete.
    act(() => {
      sw.fire({ type: 'PRECACHE_PROGRESS', loaded: 1, failed: 0, total: 2 });
    });
    expect(result.current.precacheProgress.loaded).toBe(1);
    act(() => {
      sw.fire({ type: 'PRECACHE_PROGRESS', loaded: 2, failed: 0, total: 2 });
    });
    act(() => {
      sw.fire({ type: 'PRECACHE_COMPLETE', loaded: 2, failed: 0, total: 2 });
    });
    expect(result.current.precacheStatus).toBe('done');
  });

  it('moves to "error" on PRECACHE_COMPLETE if any failures occurred', async () => {
    const sw = installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3']);
    });
    act(() => {
      sw.fire({ type: 'PRECACHE_COMPLETE', loaded: 0, failed: 1, total: 1 });
    });
    expect(result.current.precacheStatus).toBe('error');
    expect(result.current.precacheProgress.failed).toBe(1);
  });

  it('surfaces quotaExceeded as a sticky flag in progress', async () => {
    const sw = installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3']);
    });
    act(() => {
      sw.fire({
        type: 'PRECACHE_COMPLETE',
        loaded: 0,
        failed: 1,
        total: 1,
        quotaExceeded: true,
      });
    });
    expect(result.current.precacheProgress.quotaExceeded).toBe(true);
    expect(result.current.precacheStatus).toBe('error');
  });

  it('flips to "error" after the watchdog if no progress arrives within 30s', async () => {
    installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3']);
    });
    expect(result.current.precacheStatus).toBe('downloading');
    // Advance time but don't fire any messages.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(result.current.precacheStatus).toBe('error');
  });

  it('watchdog is reset by each progress message and only fires after silence', async () => {
    const sw = installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3']);
    });
    // 20s in: still downloading because hook keeps re-arming on
    // each PRECACHE_PROGRESS.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    act(() => {
      sw.fire({ type: 'PRECACHE_PROGRESS', loaded: 0, failed: 0, total: 1 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(result.current.precacheStatus).toBe('downloading');
    // Now go silent for >30s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(result.current.precacheStatus).toBe('error');
  });

  it('rejects non-finite numbers in incoming progress messages instead of producing NaN state', async () => {
    const sw = installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3']);
    });
    act(() => {
      sw.fire({ type: 'PRECACHE_PROGRESS', loaded: NaN, failed: 'oops', total: -5 });
    });
    expect(result.current.precacheProgress.loaded).toBe(0);
    expect(result.current.precacheProgress.failed).toBe(0);
    expect(result.current.precacheProgress.total).toBe(0);
  });

  it('sets status to "error" if there is no active SW when download is requested', async () => {
    const sw = installServiceWorkerStub();
    sw.setActive(null);
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3']);
    });
    expect(result.current.precacheStatus).toBe('error');
  });

  it('sets status to "error" when service worker support is missing entirely', async () => {
    // No serviceWorker on navigator.
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3']);
    });
    expect(result.current.precacheStatus).toBe('error');
  });

  it('exposes swReady=true once navigator.serviceWorker.ready resolves', async () => {
    installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    // Flush the microtask queue inside an act so React commits the
    // setSwReady triggered by the ready promise.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.swReady).toBe(true);
  });

  it('clears the watchdog on PRECACHE_COMPLETE so a late "fake stuck" event cannot fire', async () => {
    const sw = installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3']);
    });
    act(() => {
      sw.fire({ type: 'PRECACHE_COMPLETE', loaded: 1, failed: 0, total: 1 });
    });
    expect(result.current.precacheStatus).toBe('done');
    // Advance well past the watchdog window — status must stay 'done'.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(result.current.precacheStatus).toBe('done');
  });

  it('ignores malformed SW messages (null, missing type, unknown type) without crashing', async () => {
    const sw = installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3']);
    });
    expect(result.current.precacheStatus).toBe('downloading');
    act(() => {
      sw.fire(null);
      sw.fire({});
      sw.fire({ type: 'UNKNOWN' });
      sw.fire('not-an-object');
    });
    // Garbage messages must not change anything.
    expect(result.current.precacheStatus).toBe('downloading');
    expect(result.current.precacheProgress.loaded).toBe(0);
  });

  it('keeps quotaExceeded sticky across subsequent non-quota messages within the same run', async () => {
    const sw = installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    await act(async () => {
      await result.current.downloadForOffline(['./audio/a.mp3', './audio/b.mp3']);
    });
    act(() => {
      sw.fire({
        type: 'PRECACHE_PROGRESS',
        loaded: 0,
        failed: 1,
        total: 2,
        quotaExceeded: true,
      });
    });
    expect(result.current.precacheProgress.quotaExceeded).toBe(true);
    // A follow-up message that omits the flag must NOT clear it.
    act(() => {
      sw.fire({ type: 'PRECACHE_PROGRESS', loaded: 0, failed: 1, total: 2 });
    });
    expect(result.current.precacheProgress.quotaExceeded).toBe(true);
  });
});

describe('useOfflineSupport — install prompt', () => {
  it('captures beforeinstallprompt and exposes it via installPrompt', () => {
    installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());
    expect(result.current.installPrompt).toBeNull();

    const fakeEvent = Object.assign(new Event('beforeinstallprompt'), {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    act(() => {
      window.dispatchEvent(fakeEvent);
    });
    expect(result.current.installPrompt).not.toBeNull();
  });

  it('clears installPrompt after the user accepts or dismisses', async () => {
    installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());

    const prompt = vi.fn().mockResolvedValue(undefined);
    const fakeEvent = Object.assign(new Event('beforeinstallprompt'), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
    });
    act(() => {
      window.dispatchEvent(fakeEvent);
    });
    await act(async () => {
      await result.current.showInstallPrompt();
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(result.current.installPrompt).toBeNull();
  });

  it('clears installPrompt on prompt() rejection so the button hides instead of getting stuck', async () => {
    installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());

    const fakeEvent = Object.assign(new Event('beforeinstallprompt'), {
      prompt: vi.fn().mockRejectedValue(new Error('already used')),
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    act(() => {
      window.dispatchEvent(fakeEvent);
    });
    await act(async () => {
      await result.current.showInstallPrompt();
    });
    expect(result.current.installPrompt).toBeNull();
  });

  it('clears installPrompt on appinstalled (e.g. user installed via browser menu)', () => {
    installServiceWorkerStub();
    const { result } = renderHook(() => useOfflineSupport());

    const fakeEvent = Object.assign(new Event('beforeinstallprompt'), {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    act(() => {
      window.dispatchEvent(fakeEvent);
    });
    expect(result.current.installPrompt).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(result.current.installPrompt).toBeNull();
  });
});
