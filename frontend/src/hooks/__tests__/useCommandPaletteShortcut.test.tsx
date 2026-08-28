import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { isCommandPaletteChord, useCommandPaletteShortcut } from '../useCommandPaletteShortcut';

function chord(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'k', cancelable: true, ...init });
}

describe('isCommandPaletteChord', () => {
  it('accepts ⌘K and Ctrl-K', () => {
    expect(isCommandPaletteChord(chord({ metaKey: true }))).toBe(true);
    expect(isCommandPaletteChord(chord({ ctrlKey: true }))).toBe(true);
  });

  it('accepts a shifted K (caps lock, or a stray Shift)', () => {
    expect(isCommandPaletteChord(chord({ key: 'K', metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('rejects a bare k so typing still works', () => {
    expect(isCommandPaletteChord(chord({}))).toBe(false);
  });

  it('rejects other keys and other modifier combos', () => {
    expect(isCommandPaletteChord(chord({ key: 'j', metaKey: true }))).toBe(false);
    expect(isCommandPaletteChord(chord({ metaKey: true, altKey: true }))).toBe(false);
    // Ctrl-⌘-K belongs to the OS, not to us.
    expect(isCommandPaletteChord(chord({ metaKey: true, ctrlKey: true }))).toBe(false);
  });
});

function Host({ onTrigger }: { onTrigger: () => void }) {
  useCommandPaletteShortcut(onTrigger);
  return <input aria-label="somewhere else" />;
}

describe('useCommandPaletteShortcut', () => {
  it('fires from anywhere on the page, including inside a text field', () => {
    const onTrigger = vi.fn();
    render(<Host onTrigger={onTrigger} />);
    fireEvent.keyDown(screen.getByLabelText('somewhere else'), { key: 'k', metaKey: true });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('swallows the browser default so Ctrl-K does not hit the address bar', () => {
    render(<Host onTrigger={vi.fn()} />);
    const event = chord({ ctrlKey: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
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
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
