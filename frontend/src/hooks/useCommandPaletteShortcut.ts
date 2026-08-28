// ⌘K (macOS) / Ctrl-K (everywhere else) opens the command palette.
//
// Document-level and capture-phase on purpose: the editor is full of
// surfaces that swallow keys (CodeMirror in the source editors, the
// ReactFlow canvas, every text input), and the shortcut has to work
// from all of them. preventDefault is what stops Chrome from handing
// Ctrl-K to the address bar.

import { useEffect } from 'react';

export function isCommandPaletteChord(e: KeyboardEvent): boolean {
  // `key` is 'k'/'K' depending on Shift; `code` would also match a
  // Dvorak user's physical K, which is not what they'd expect.
  if (e.key !== 'k' && e.key !== 'K') return false;
  if (e.altKey) return false;
  // Exactly one of the two — Ctrl-⌘-K isn't our chord.
  return e.metaKey !== e.ctrlKey;
}

/**
 * @param onTrigger called every time the chord fires — including
 *   while the palette is already open, so the host can toggle. Keep
 *   it stable (useCallback) or the listener re-binds every render.
 */
export function useCommandPaletteShortcut(onTrigger: () => void): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isCommandPaletteChord(e)) return;
      e.preventDefault();
      onTrigger();
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onTrigger]);
}
