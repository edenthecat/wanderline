// Author QoL: undo/redo over the collaborative Y.Doc.
//
// Yjs ships `UndoManager` which tracks structural deltas on the
// types you register with it. We bind it to the project's
// `nodes` map (the part of the Doc that holds editable story
// content) so Ctrl+Z reverts the last local edit — even if other
// collaborators have been editing concurrently. The manager
// scopes by transaction origin: by default it ignores remote
// peer updates so you can only undo YOUR own changes, not your
// co-author's.
//
// Keyboard shortcuts:
//   - Ctrl/Cmd-Z: undo
//   - Ctrl/Cmd-Shift-Z or Ctrl/Cmd-Y: redo
//
// Both are debounced via the natural Yjs grouping (default
// captureTimeout=500ms) so a flurry of keystrokes collapses into
// a single undoable unit. The hook does nothing when the input
// focus is on a contenteditable / textarea / input outside the
// project surfaces — the browser's native undo handles those.
// We trigger only when focus is on the document body OR on one of
// our collaborative inputs (which we mark with data-yjs-input).

import { useEffect, useRef } from 'react';
import * as Y from 'yjs';

const NODES_KEY = 'nodes';

interface UseYjsUndoResult {
  undo: () => void;
  redo: () => void;
  /** Current undo-stack depth. Imperative — call when you render a
   * toolbar button. Doesn't force re-renders on stack changes; a
   * future toolbar UI will subscribe to the manager directly. */
  getUndoDepth: () => number;
  getRedoDepth: () => number;
}

export function useYjsUndo(doc: Y.Doc | null): UseYjsUndoResult {
  const managerRef = useRef<Y.UndoManager | null>(null);

  useEffect(() => {
    if (!doc) {
      managerRef.current = null;
      return;
    }
    const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
    // trackedOrigins selects WHICH transactions the manager captures.
    // We want local edits in (so Ctrl-Z reverts MY changes) and
    // remote applies out (so I can't undo my collaborator).
    //   - useYjsTextField uses `doc.transact(apply, 'local')`
    //     → origin === 'local'
    //   - any bare doc.transact(...) call (no origin)
    //     → origin === null
    //   - WebsocketProvider applies remote updates with the provider
    //     instance as origin → not in this set, ignored
    //   - 'seed' (one-time initial value) is intentionally excluded
    //     so the seed isn't undoable
    const manager = new Y.UndoManager(nodesMap, {
      captureTimeout: 500,
      trackedOrigins: new Set<unknown>(['local', null]),
    });
    managerRef.current = manager;
    return () => {
      manager.destroy();
      managerRef.current = null;
    };
  }, [doc]);

  // Keyboard handler. Mounted once, reads ref so it always sees
  // the current manager.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!managerRef.current) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Ignore when the user is interacting with native UI that
      // has its own undo (e.g. an audio upload dialog).
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isFormControl =
        tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true;
      // Inputs marked data-yjs-input ARE bound to the Y.Doc, so
      // we want to handle the shortcut for them too.
      const isYjsInput = target?.dataset?.yjsInput === 'true';
      if (isFormControl && !isYjsInput) return;

      const key = e.key.toLowerCase();
      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
      if (!isUndo && !isRedo) return;
      // Only swallow the keystroke if we actually have something to
      // do. Otherwise Cmd-Z on an empty stack would block whatever
      // the browser would've done (browser native undo on a stray
      // form control, an extension shortcut, etc.).
      const mgr = managerRef.current;
      if (isUndo && mgr.undoStack.length === 0) return;
      if (isRedo && mgr.redoStack.length === 0) return;
      e.preventDefault();
      if (isUndo) mgr.undo();
      else mgr.redo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return {
    undo: () => managerRef.current?.undo(),
    redo: () => managerRef.current?.redo(),
    getUndoDepth: () => managerRef.current?.undoStack.length ?? 0,
    getRedoDepth: () => managerRef.current?.redoStack.length ?? 0,
  };
}
