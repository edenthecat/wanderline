import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  isApplePlatform,
  isCommandPaletteChord,
  useCommandPaletteShortcut,
} from '../useCommandPaletteShortcut';

function chord(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'k', cancelable: true, bubbles: true, ...init });
}

/** jsdom reports an empty navigator.platform, so tests that care
 * about the platform gate say which one they mean. */
function withPlatform(value: string, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'platform', { value, configurable: true });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(window.navigator, 'platform', original);
    else delete (window.navigator as { platform?: string }).platform;
  }
}

describe('isApplePlatform', () => {
  it('recognises Mac and iOS platform strings', () => {
    withPlatform('MacIntel', () => expect(isApplePlatform()).toBe(true));
    withPlatform('iPhone', () => expect(isApplePlatform()).toBe(true));
  });

  it('says no for everything else', () => {
    withPlatform('Win32', () => expect(isApplePlatform()).toBe(false));
    withPlatform('Linux x86_64', () => expect(isApplePlatform()).toBe(false));
  });
});

describe('isCommandPaletteChord', () => {
  it('is ⌘K on Apple platforms', () => {
    expect(isCommandPaletteChord(chord({ metaKey: true }), true)).toBe(true);
    // Ctrl-K on macOS is emacs kill-to-end-of-line, which CodeMirror
    // binds in both source editors. It is NOT our chord there.
    expect(isCommandPaletteChord(chord({ ctrlKey: true }), true)).toBe(false);
  });

  it('is Ctrl-K everywhere else', () => {
    expect(isCommandPaletteChord(chord({ ctrlKey: true }), false)).toBe(true);
    expect(isCommandPaletteChord(chord({ metaKey: true }), false)).toBe(false);
  });

  it('accepts a shifted K (caps lock, or a stray Shift)', () => {
    expect(isCommandPaletteChord(chord({ key: 'K', metaKey: true, shiftKey: true }), true)).toBe(
      true,
    );
  });

  it('rejects a bare k so typing still works', () => {
    expect(isCommandPaletteChord(chord({}), true)).toBe(false);
    expect(isCommandPaletteChord(chord({}), false)).toBe(false);
  });

  it('rejects other keys and other modifier combos', () => {
    expect(isCommandPaletteChord(chord({ key: 'j', metaKey: true }), true)).toBe(false);
    expect(isCommandPaletteChord(chord({ metaKey: true, altKey: true }), true)).toBe(false);
    // Ctrl-⌘-K belongs to the OS, not to us.
    expect(isCommandPaletteChord(chord({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isCommandPaletteChord(chord({ metaKey: true, ctrlKey: true }), false)).toBe(false);
  });

  it('falls back to the live platform when the caller does not say', () => {
    withPlatform('MacIntel', () => {
      expect(isCommandPaletteChord(chord({ metaKey: true }))).toBe(true);
      expect(isCommandPaletteChord(chord({ ctrlKey: true }))).toBe(false);
    });
    withPlatform('Win32', () => {
      expect(isCommandPaletteChord(chord({ ctrlKey: true }))).toBe(true);
    });
  });
});

function Host({ onTrigger }: { onTrigger: () => void }) {
  useCommandPaletteShortcut(onTrigger);
  return <input aria-label="somewhere else" />;
}

afterEach(() => vi.restoreAllMocks());

describe('useCommandPaletteShortcut', () => {
  it('fires from anywhere on the page, including inside a text field', () => {
    const onTrigger = vi.fn();
    render(<Host onTrigger={onTrigger} />);
    withPlatform('MacIntel', () => {
      fireEvent.keyDown(screen.getByLabelText('somewhere else'), { key: 'k', metaKey: true });
    });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('swallows the browser default so Ctrl-K does not hit the address bar', () => {
    render(<Host onTrigger={vi.fn()} />);
    withPlatform('Win32', () => {
      const event = chord({ ctrlKey: true });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it('stops the chord reaching editors that bind the same keys', () => {
    // CodeMirror listens on its own contentDOM in the bubble phase and
    // ignores defaultPrevented, so the capture listener has to cut the
    // event off rather than merely cancel it.
    const onTrigger = vi.fn();
    const bubbleListener = vi.fn();
    render(<Host onTrigger={onTrigger} />);
    const field = screen.getByLabelText('somewhere else');
    field.addEventListener('keydown', bubbleListener);
    withPlatform('MacIntel', () => {
      fireEvent.keyDown(field, { key: 'k', metaKey: true });
    });
    expect(onTrigger).toHaveBeenCalled();
    expect(bubbleListener).not.toHaveBeenCalled();
  });

  it('ignores ordinary typing', () => {
    const onTrigger = vi.fn();
    render(<Host onTrigger={onTrigger} />);
    fireEvent.keyDown(document, { key: 'k' });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    const onTrigger = vi.fn();
    const { unmount } = render(<Host onTrigger={onTrigger} />);
    unmount();
    withPlatform('MacIntel', () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
