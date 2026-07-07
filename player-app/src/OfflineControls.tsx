// Visible UI for offline support:
//   - An "Offline" pill that appears at the top of the screen
//     when navigator.onLine flips false. Goes away on reconnect.
//   - A "Download for offline" button + progress strip that the
//     user can tap to pre-cache every audio file the story uses.
//     Hidden when SW isn't available (file://, insecure context,
//     unsupported browser) so we don't show a broken affordance.
//   - "Add to home screen" — surfaces the browser's PWA install
//     prompt when one fires. Mostly Android Chrome/Edge.
//
// Designed to be drop-in: App.tsx renders it once near the root
// and passes the list of audio URLs to precache. The component
// owns the user-facing copy.

import type { OfflineSupport } from './useOfflineSupport';

interface Props {
  support: OfflineSupport;
  /** Every audio URL the story references — used for the precache cycle. */
  audioUrls: string[];
}

export default function OfflineControls({ support, audioUrls }: Props) {
  const {
    online,
    swReady,
    precacheStatus,
    precacheProgress,
    installPrompt,
    downloadForOffline,
    showInstallPrompt,
  } = support;

  const offlineCapable = swReady && audioUrls.length > 0;
  const downloading = precacheStatus === 'downloading';
  const done = precacheStatus === 'done';
  const failed = precacheStatus === 'error' && precacheProgress.total > 0;
  const quotaExceeded = precacheProgress.quotaExceeded;

  // The player's outer container has an onClick that advances the
  // story; stopPropagation here prevents tapping any of our
  // controls from also kicking off audio playback.
  return (
    <div onClick={(e) => e.stopPropagation()}>
      {!online && (
        <div className="wl-offline-banner" role="status" aria-live="polite">
          You&rsquo;re offline. The story will keep playing from anything that&rsquo;s already
          loaded.
        </div>
      )}
      {(offlineCapable || installPrompt) && (
        <div className="wl-offline-controls">
          {offlineCapable && !downloading && !done && (
            <button
              type="button"
              className="wl-offline-btn"
              onClick={() => void downloadForOffline(audioUrls)}
              disabled={!online || quotaExceeded}
              title={
                quotaExceeded
                  ? "Your device doesn't have enough free space."
                  : online
                    ? 'Download every audio file to your device so you can keep playing offline.'
                    : 'Reconnect to download for offline.'
              }
            >
              {quotaExceeded
                ? 'Out of space'
                : failed
                  ? `Retry download (${precacheProgress.failed} failed)`
                  : 'Download for offline'}
            </button>
          )}
          {offlineCapable && downloading && (
            <div className="wl-offline-progress" aria-live="polite">
              Downloading {precacheProgress.loaded + precacheProgress.failed} /{' '}
              {precacheProgress.total}
              {precacheProgress.failed > 0 && (
                <span className="wl-offline-failed"> ({precacheProgress.failed} failed)</span>
              )}
            </div>
          )}
          {offlineCapable && done && (
            <div className="wl-offline-done" aria-live="polite">
              ✓ Ready for offline play
            </div>
          )}
          {installPrompt && (
            <button
              type="button"
              className="wl-install-btn"
              onClick={() => void showInstallPrompt()}
            >
              Add to home screen
            </button>
          )}
        </div>
      )}
    </div>
  );
}
