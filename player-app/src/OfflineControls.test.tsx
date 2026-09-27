import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OfflineControls from './OfflineControls';
import type { OfflineSupport } from './useOfflineSupport';

function support(overrides: Partial<OfflineSupport> = {}): OfflineSupport {
  return {
    online: true,
    swReady: true,
    precacheStatus: 'idle',
    precacheProgress: { loaded: 0, failed: 0, total: 0, quotaExceeded: false, corsBlocked: 0 },
    installPrompt: null,
    cacheStatus: { cached: 0, total: 0, bytes: 0, checked: false },
    refreshCacheStatus: vi.fn(),
    downloadForOffline: vi.fn(async () => {}),
    showInstallPrompt: vi.fn(async () => {}),
    ...overrides,
  };
}

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120';

/** BeforeInstallPromptEvent isn't in lib.dom; a minimal stub is enough here. */
function fakeInstallPrompt(): OfflineSupport['installPrompt'] {
  return {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  } as unknown as OfflineSupport['installPrompt'];
}

const URLS = ['./audio/a.mp3', './audio/b.mp3'];

describe('OfflineControls — offline readiness', () => {
  it('queries the cache once the worker is ready', () => {
    const refreshCacheStatus = vi.fn();
    render(<OfflineControls support={support({ refreshCacheStatus })} audioUrls={URLS} />);
    expect(refreshCacheStatus).toHaveBeenCalledWith(URLS);
  });

  // Survives a reload: this is read from the cache, not from a flag
  // set by this session's download.
  it('shows a complete save with its size', () => {
    render(
      <OfflineControls
        support={support({
          cacheStatus: { cached: 60, total: 60, bytes: 41_943_040, checked: true },
        })}
        audioUrls={URLS}
      />,
    );
    expect(screen.getByText(/Saved for offline/)).toBeTruthy();
    expect(screen.getByText(/40 MB/)).toBeTruthy();
    // Nothing left to fetch, so don't offer to.
    expect(screen.queryByText(/Download for offline/)).toBeNull();
  });

  it('shows how much is missing and offers to finish', () => {
    render(
      <OfflineControls
        support={support({ cacheStatus: { cached: 48, total: 60, bytes: 1000, checked: true } })}
        audioUrls={URLS}
      />,
    );
    expect(screen.getByText(/48 of 60 saved/)).toBeTruthy();
    expect(screen.getByText(/Finish download \(12 left\)/)).toBeTruthy();
  });

  // Don't flash "0 saved" in the gap between the worker waking and
  // answering the query.
  it('claims nothing before the cache has been read', () => {
    render(
      <OfflineControls
        support={support({ cacheStatus: { cached: 0, total: 0, bytes: 0, checked: false } })}
        audioUrls={URLS}
      />,
    );
    expect(screen.queryByText(/saved/i)).toBeNull();
    expect(screen.getByText('Download for offline')).toBeTruthy();
  });

  describe('when offline', () => {
    it('reassures a listener whose story is fully saved', () => {
      render(
        <OfflineControls
          support={support({
            online: false,
            cacheStatus: { cached: 60, total: 60, bytes: 0, checked: true },
          })}
          audioUrls={URLS}
        />,
      );
      expect(screen.getByText(/whole story is saved on your device/)).toBeTruthy();
    });

    it('is specific about what a partial save can play', () => {
      render(
        <OfflineControls
          support={support({
            online: false,
            cacheStatus: { cached: 48, total: 60, bytes: 0, checked: true },
          })}
          audioUrls={URLS}
        />,
      );
      expect(screen.getByText(/48 of 60 parts are saved/)).toBeTruthy();
    });
  });

  // Retrying can never clear a server-side CORS policy, so don't
  // invite the listener to burn data on it.
  it('explains a CORS block instead of offering a retry', () => {
    render(
      <OfflineControls
        support={support({
          precacheStatus: 'error',
          precacheProgress: {
            loaded: 0,
            failed: 5,
            total: 5,
            quotaExceeded: false,
            corsBlocked: 5,
          },
        })}
        audioUrls={URLS}
      />,
    );
    expect(screen.getByText(/isn’t available for this story/)).toBeTruthy();
    expect(screen.queryByText(/Retry download/)).toBeNull();
  });
});

describe('the install prompt is mobile-only', () => {
  const originalUA = navigator.userAgent;
  afterEach(() => setUserAgent(originalUA));

  // `beforeinstallprompt` fires on desktop Chrome/Edge same as mobile,
  // but a desktop listener has no real use for installing — see
  // InstallGuidance.tsx for why. The button should stay hidden there
  // even though the browser handed us a real prompt to show.
  it('does not show "Add to home screen" on desktop', () => {
    setUserAgent(MAC);
    render(
      <OfflineControls
        support={support({ installPrompt: fakeInstallPrompt(), swReady: false })}
        audioUrls={[]}
      />,
    );
    expect(screen.queryByText('Add to home screen')).toBeNull();
  });

  it('shows "Add to home screen" on mobile when the browser offers one', () => {
    setUserAgent(ANDROID);
    render(
      <OfflineControls
        support={support({ installPrompt: fakeInstallPrompt(), swReady: false })}
        audioUrls={[]}
      />,
    );
    expect(screen.getByText('Add to home screen')).toBeTruthy();
  });
});
