import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InstallGuidance, { detectPlatform, isStandalone } from './InstallGuidance';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1';
const IPAD_OS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function setUserAgent(ua: string, maxTouchPoints = 0) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  setUserAgent(ANDROID);
  // jsdom has no matchMedia; default it to "not standalone".
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectPlatform', () => {
  it('recognises iPhone', () => {
    expect(detectPlatform(IPHONE)).toBe('ios');
  });

  // iPadOS 13+ reports a desktop Safari UA; only the touch-point count
  // separates it from a Mac. Getting this wrong shows iPad users
  // address-bar instructions for a UI they don't have.
  it('recognises iPadOS despite its desktop user-agent', () => {
    setUserAgent(IPAD_OS, 5);
    expect(detectPlatform(IPAD_OS)).toBe('ios');
  });

  it('does not mistake a real Mac for an iPad', () => {
    setUserAgent(MAC, 0);
    expect(detectPlatform(MAC)).toBe('desktop');
  });

  it('recognises Android', () => {
    expect(detectPlatform(ANDROID)).toBe('android');
  });
});

describe('isStandalone', () => {
  it('is true when iOS reports navigator.standalone', () => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    expect(isStandalone()).toBe(true);
    Object.defineProperty(navigator, 'standalone', { value: undefined, configurable: true });
  });

  it('is true when the display-mode media query matches', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    expect(isStandalone()).toBe(true);
  });
});

describe('InstallGuidance', () => {
  it('shows platform-specific steps when no native prompt exists', () => {
    setUserAgent(IPHONE);
    render(<InstallGuidance hasNativePrompt={false} />);
    expect(screen.getByText(/Add to Home Screen/i)).toBeTruthy();
    expect(screen.getByText(/only works in Safari/i)).toBeTruthy();
  });

  // When the browser gives us a real button, the manual walkthrough is
  // just noise sitting on top of it.
  it('defers to the native prompt when one is available', () => {
    const { container } = render(<InstallGuidance hasNativePrompt />);
    expect(container.querySelector('.wl-install-guidance')).toBeNull();
  });

  it('stays hidden once already installed', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    const { container } = render(<InstallGuidance hasNativePrompt={false} />);
    expect(container.querySelector('.wl-install-guidance')).toBeNull();
  });

  it('remembers a dismissal', () => {
    const { container, unmount } = render(<InstallGuidance hasNativePrompt={false} />);
    fireEvent.click(screen.getByText('Got it'));
    expect(container.querySelector('.wl-install-guidance')).toBeNull();
    unmount();
    const second = render(<InstallGuidance hasNativePrompt={false} />);
    expect(second.container.querySelector('.wl-install-guidance')).toBeNull();
  });

  // Private mode throws on localStorage access; the player must still
  // render rather than crash on a storage read.
  it('still renders when localStorage is unavailable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      render(<InstallGuidance hasNativePrompt={false} />);
      expect(screen.getByText(/install this story as an app/i)).toBeTruthy();
    } finally {
      getItem.mockRestore();
    }
  });
});
