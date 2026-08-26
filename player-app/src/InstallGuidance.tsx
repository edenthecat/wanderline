// "Install this as an app" guidance for listeners.
//
// The browser's own install prompt (`beforeinstallprompt`) only fires
// on Chromium — Safari has never implemented it, so on iPhone, which
// is the single most common device for a headphones-first audio story,
// no automatic affordance exists at all. Every generated build is
// supposed to tell listeners to install, so where we can't offer a
// button we show the platform's manual steps instead.
//
// Installing genuinely matters here rather than being a nicety: a
// standalone window keeps audio alive across screen lock on more
// devices, and it's the only context where the service worker's
// offline cache is reliably retained.

import { useEffect, useState } from 'react';

const DISMISS_KEY = 'wl-install-guidance-dismissed';

type Platform = 'ios' | 'android' | 'desktop';

/** Already running as an installed app — nothing to suggest. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // `navigator.standalone` is the iOS-only signal; the media query is
  // the standard one every other engine honours.
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const mediaStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  return iosStandalone || mediaStandalone;
}

export function detectPlatform(ua: string): Platform {
  // iPadOS 13+ reports a desktop Safari UA, so the touch-point check
  // is the only way to tell an iPad from a Mac. Without it, iPad users
  // get Chrome-flavoured instructions that don't exist on their device.
  const isIpadOS =
    /Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || isIpadOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

const INSTRUCTIONS: Record<Platform, { steps: string; note?: string }> = {
  ios: {
    steps: 'Tap the Share button, then “Add to Home Screen”.',
    // Worth saying explicitly: iOS silently refuses to install from
    // any browser that isn't Safari, and the Share sheet simply won't
    // offer the option, which reads as a broken instruction.
    note: 'On iPhone and iPad this only works in Safari.',
  },
  android: {
    steps: 'Open the browser menu (⋮), then “Install app” or “Add to Home screen”.',
  },
  desktop: {
    steps: 'Click the install icon at the right-hand end of the address bar.',
    note: 'Available in Chrome and Edge.',
  },
};

interface Props {
  /** True when the browser gave us a real prompt — the button is better. */
  hasNativePrompt: boolean;
}

export default function InstallGuidance({ hasNativePrompt }: Props) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // Read in an effect rather than lazy state so SSR / a storage-
    // blocked context can't throw during render.
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      // Private mode or blocked storage: show the guidance. It's
      // dismissible either way, it just won't be remembered.
      setDismissed(false);
    }
  }, []);

  if (hasNativePrompt || isStandalone() || dismissed) return null;

  const platform = detectPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const { steps, note } = INSTRUCTIONS[platform];

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Not remembering the dismissal is acceptable; re-showing it on
      // the next visit is better than crashing the player.
    }
  };

  return (
    <div className="wl-install-guidance" role="note">
      <p className="wl-install-guidance-lead">
        For the best experience, install this story as an app.
      </p>
      <p className="wl-install-guidance-steps">{steps}</p>
      <p className="wl-install-guidance-why">
        It plays full-screen, keeps going when your screen locks, and can be downloaded to play with
        no connection.
      </p>
      {note && <p className="wl-install-guidance-note">{note}</p>}
      <button type="button" className="wl-install-guidance-dismiss" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
