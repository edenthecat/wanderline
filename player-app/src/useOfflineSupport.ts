// Hook surfacing the player's offline state for the UI:
//   - `online`: live navigator.onLine, updated on online/offline events.
//   - `precacheStatus`: 'idle' | 'downloading' | 'done' | 'error'
//   - `precacheProgress`: {loaded, failed, total} from the SW's
//     PRECACHE_PROGRESS messages, plus a sticky quotaExceeded flag.
//   - `installPrompt`: BeforeInstallPromptEvent if the browser
//     surfaced one (Chrome/Edge on Android), null otherwise. Calling
//     .prompt() on it opens the native "Add to home screen" sheet.
//   - `downloadForOffline(urls)`: posts PRECACHE_AUDIO to the SW so
//     it walks the URL list and caches each file. No-op (returns
//     immediately, sets status='error') if there's no SW (file://
//     or insecure context).
//
// Designed to render gracefully when SW isn't available: the UI
// just hides the offline-download affordance instead of showing a
// broken button.
//
// Robustness details:
//   - The SW emits both per-step PRECACHE_PROGRESS and a terminal
//     PRECACHE_COMPLETE so we don't have to infer "done" from
//     loaded+failed===total (which would get stuck if any single
//     postMessage was dropped).
//   - A watchdog timer flips status to 'error' if neither progress
//     nor completion has been seen in WATCHDOG_MS — guards against
//     a backgrounded-tab SW that browsers GC'd mid-precache.
//   - QuotaExceededError mid-precache is surfaced as a distinct
//     signal (precacheProgress.quotaExceeded) so the UI can
//     suggest "your device is full" instead of just "X failed".

import { useEffect, useState, useCallback, useRef } from 'react';

export type PrecacheStatus = 'idle' | 'downloading' | 'done' | 'error';

export interface PrecacheProgress {
  loaded: number;
  failed: number;
  total: number;
  quotaExceeded: boolean;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface OfflineSupport {
  online: boolean;
  swReady: boolean;
  precacheStatus: PrecacheStatus;
  precacheProgress: PrecacheProgress;
  installPrompt: BeforeInstallPromptEvent | null;
  downloadForOffline: (urls: string[]) => Promise<void>;
  showInstallPrompt: () => Promise<void>;
}

// If no progress for this long, declare the precache stuck. Browsers
// can suspend service workers idle in the background, particularly
// on Android — the user shouldn't see a stuck spinner forever.
const WATCHDOG_MS = 30_000;

function readNonNegativeInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export function useOfflineSupport(): OfflineSupport {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [swReady, setSwReady] = useState(false);
  const [precacheStatus, setPrecacheStatus] = useState<PrecacheStatus>('idle');
  const [precacheProgress, setPrecacheProgress] = useState<PrecacheProgress>({
    loaded: 0,
    failed: 0,
    total: 0,
    quotaExceeded: false,
  });
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Online / offline events.
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // SW ready check + message handler.
  useEffect(() => {
    // `'serviceWorker' in navigator` returns true even when the
    // property is explicitly set to undefined (jsdom test stubs do
    // this). Check truthiness so we don't crash with "cannot read
    // 'ready' of undefined".
    const sw = navigator.serviceWorker;
    if (!sw) return;
    sw.ready.then(() => setSwReady(true)).catch(() => setSwReady(false));

    const armWatchdog = () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        // Promote whatever progress we have to a final 'error'
        // outcome so the UI can offer a retry instead of spinning.
        setPrecacheStatus((s) => (s === 'downloading' ? 'error' : s));
      }, WATCHDOG_MS);
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'PRECACHE_PROGRESS' || data.type === 'PRECACHE_COMPLETE') {
        const loaded = readNonNegativeInt(data.loaded);
        const failed = readNonNegativeInt(data.failed);
        const total = readNonNegativeInt(data.total);
        const quotaExceeded = Boolean(data.quotaExceeded);
        // quotaExceeded is sticky on the consumer side: once we've
        // hit storage exhaustion in this precache run, downstream
        // messages can't accidentally clear the flag. The SW
        // currently always re-sets it, but consumer-side stickiness
        // makes the contract explicit.
        setPrecacheProgress((prev) => ({
          loaded,
          failed,
          total,
          quotaExceeded: quotaExceeded || prev.quotaExceeded,
        }));
        if (data.type === 'PRECACHE_COMPLETE') {
          if (watchdogRef.current) clearTimeout(watchdogRef.current);
          // The SW's terminal message is the source of truth. If
          // any failures or quota issues, surface 'error' so the
          // UI can offer a retry.
          setPrecacheStatus(failed > 0 || quotaExceeded ? 'error' : 'done');
        } else {
          // A live progress message — push the watchdog out.
          armWatchdog();
        }
      }
    };
    sw.addEventListener('message', onMessage);
    return () => {
      sw.removeEventListener('message', onMessage);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, []);

  // Capture the browser's PWA install prompt so we can fire it
  // from a button later (Chrome/Edge require it to come from a
  // user gesture, not at page load).
  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const downloadForOffline = useCallback(async (urls: string[]) => {
    if (!navigator.serviceWorker) {
      setPrecacheStatus('error');
      return;
    }
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg?.active) {
      setPrecacheStatus('error');
      return;
    }
    setPrecacheProgress({ loaded: 0, failed: 0, total: urls.length, quotaExceeded: false });
    setPrecacheStatus('downloading');
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      setPrecacheStatus((s) => (s === 'downloading' ? 'error' : s));
    }, WATCHDOG_MS);
    reg.active.postMessage({ type: 'PRECACHE_AUDIO', urls });
  }, []);

  const showInstallPrompt = useCallback(async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch {
      // prompt() throws if the event has already been used or the
      // browser no longer considers the page eligible. Either way,
      // the event is dead — clear it so the button hides.
    } finally {
      setInstallPrompt(null);
    }
  }, [installPrompt]);

  return {
    online,
    swReady,
    precacheStatus,
    precacheProgress,
    installPrompt,
    downloadForOffline,
    showInstallPrompt,
  };
}
