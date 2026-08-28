// ⌘K (macOS) / Ctrl-K (everywhere else) opens the command palette.
//
// Document-level and capture-phase on purpose: the editor is full of
// surfaces that swallow keys (CodeMirror in the source editors, the
// ReactFlow canvas, every text input), and the shortcut has to work
// from all of them.
//
// The chord is exactly one modifier — the platform's own — plus K.
// On macOS
// Ctrl-K is emacs' kill-to-end-of-line, which CodeMirror's
// defaultKeymap installs for real (via emacsStyleKeymap) in both
// source editors — accepting it here would open the palette AND eat
// the rest of the author's line behind the modal, because CodeMirror
// dispatches from its own bubble-phase listener and never consults
// defaultPrevented. stopPropagation on our own chord closes the same
// door from the other side.

import { useEffect } from 'react';

/** Best-effort "is this an Apple keyboard layout" check. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
}

export function isCommandPaletteChord(e: KeyboardEvent, apple = isApplePlatform()): boolean {
  // `key` is 'k'/'K' depending on Shift; `code` would also match a
  // Dvorak user's physical K, which is not what they'd expect. Caps
  // Lock reports 'K' with shiftKey false, so accepting both letters
  // costs us nothing here.
  if (e.key !== 'k' && e.key !== 'K') return false;
  // Shift-Mod-K is CodeMirror's deleteLine (defaultKeymap, installed
  // in both source editors) and Firefox's Web Console. Exactly the
  // modifier we want, and nothing else.
  if (e.altKey || e.shiftKey) return false;
  // One modifier, the platform's own — never both.
  return apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * @param onTrigger called every time the chord fires — including
 *   while the palette is already open, so the host can toggle. Keep
 *   it stable (useCallback) or the listener re-binds every render.
 * @param enabled bind at all. False while the host has no palette to
 *   show, so the chord keeps its browser default (Firefox's quick
 *   find) instead of being swallowed for nothing.
 */
export function useCommandPaletteShortcut(onTrigger: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (!isCommandPaletteChord(e)) return;
      e.preventDefault();
      e.stopPropagation();
      // Holding the chord down auto-repeats; since the host toggles,
      // that would strobe the palette at the key-repeat rate.
      if (e.repeat) return;
      onTrigger();
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onTrigger, enabled]);
}
