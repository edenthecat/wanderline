// Visible UI for offline support:
//   - An "Offline" pill that appears at the top of the screen
//     when navigator.onLine flips false. Goes away on reconnect.
//   - A "Download for offline" button + progress strip that the
//     user can tap to pre-cache every audio file the story uses.
//     Hidden when SW isn't available (file://, insecure context,
//     unsupported browser) so we don't show a broken affordance.
//   - "Add to home screen" — surfaces the browser's PWA install
//     prompt when one fires. Mostly Android Chrome/Edge.
//   - InstallGuidance — the manual fallback for every browser that
//     never fires that prompt (all of Safari, notably), so the
//     install advice reaches iPhone listeners too.
//   - A persistent readiness figure ("48 of 60 chapters saved"). This
//     is read back from the cache rather than from the download
//     counter, because the counter dies with the tab: someone who
//     downloaded a story last night and opens it on the subway this
//     morning needs to know what's actually on their phone, and a
//     session-scoped "done" flag can't tell them.
//
// Designed to be drop-in: App.tsx renders it once near the root
// and passes the list of audio URLs to precache. The component
// owns the user-facing copy.

import { useEffect } from 'react';
import type { OfflineSupport } from './useOfflineSupport';
import InstallGuidance from './InstallGuidance';

interface Props {
  support: OfflineSupport;
  /** Every audio URL the story references — used for the precache cycle. */
  audioUrls: string[];
}

/**
 * Human-readable size suffix, or an empty string when the worker
 * couldn't tell us. Shown because "is 40MB going to fit / is this
 * worth doing on cellular" is the actual question someone has before
 * a flight.
 */
function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return ` \u00b7 ${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return ` \u00b7 ${Math.round(mb)} MB`;
  return ` \u00b7 ${mb.toFixed(1)} MB`;
}

export default function OfflineControls({ support, audioUrls }: Props) {
  const {
    online,
    swReady,
    precacheStatus,
    precacheProgress,
    installPrompt,
    cacheStatus,
    refreshCacheStatus,
    downloadForOffline,
    showInstallPrompt,
  } = support;

  // Read the cache once the worker is up, and again whenever the story
  // changes which files it needs.
  const urlKey = audioUrls.join('\u0000');
  useEffect(() => {
    if (!swReady || audioUrls.length === 0) return;
    refreshCacheStatus(audioUrls);
    // audioUrls is rebuilt every render by the caller; key off its
    // contents so this doesn't re-fire on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swReady, urlKey, refreshCacheStatus]);

  const offlineCapable = swReady && audioUrls.length > 0;
  const downloading = precacheStatus === 'downloading';
  const failed = precacheStatus === 'error' && precacheProgress.total > 0;
  const quotaExceeded = precacheProgress.quotaExceeded;
  // A CORS wall fails every file identically and retrying can never
  // clear it, so it gets its own message and suppresses the retry
  // affordance — offering "Retry" against a server-side policy just
  // wastes the listener's time and data.
  const corsBlocked = precacheProgress.corsBlocked > 0;

  // Readiness is derived from the cache report, so it survives a
  // reload. `checked` guards against flashing "0 saved" in the moment
  // between the worker waking and answering.
  const { cached, total: cacheTotal, bytes, checked } = cacheStatus;
  const fullySaved = checked && cacheTotal > 0 && cached === cacheTotal;
  const partiallySaved = checked && cached > 0 && cached < cacheTotal;
  const remaining = Math.max(0, cacheTotal - cached);

  // The player's outer container has an onClick that advances the
  // story; stopPropagation here prevents tapping any of our
  // controls from also kicking off audio playback.
  return (
    <div onClick={(e) => e.stopPropagation()}>
      {!online && (
        <div className="wl-offline-banner" role="status" aria-live="polite">
          {fullySaved
            ? 'You\u2019re offline \u2014 but this whole story is saved on your device, so it will play through.'
            : partiallySaved
              ? `You\u2019re offline. ${cached} of ${cacheTotal} parts are saved; the rest need a connection.`
              : 'You\u2019re offline. The story will keep playing from anything that\u2019s already loaded.'}
        </div>
      )}
      {(offlineCapable || installPrompt) && (
        <div className="wl-offline-controls">
          {offlineCapable && !downloading && !fullySaved && !corsBlocked && (
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
                  : partiallySaved
                    ? `Finish download (${remaining} left)`
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
          {/* Persistent readiness, independent of this session's
              download. Hidden while a download is running so the two
              counters don't argue with each other on screen. */}
          {offlineCapable && !downloading && fullySaved && (
            <div className="wl-offline-done" aria-live="polite">
              ✓ Saved for offline{formatSize(bytes)}
            </div>
          )}
          {offlineCapable && !downloading && partiallySaved && (
            <div className="wl-offline-partial" aria-live="polite">
              {cached} of {cacheTotal} saved{formatSize(bytes)}
            </div>
          )}
          {offlineCapable && failed && corsBlocked && (
            <div className="wl-offline-failed" aria-live="polite">
              Offline download isn&rsquo;t available for this story. The audio is served from a
              location this app isn&rsquo;t permitted to save from — playback still works while
              you&rsquo;re connected.
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
      <InstallGuidance hasNativePrompt={Boolean(installPrompt)} />
    </div>
  );
}
