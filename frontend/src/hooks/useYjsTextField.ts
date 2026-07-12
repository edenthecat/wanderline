// Bind an HTMLInputElement to a Y.Text living on a shared Y.Doc.
//
// Pattern used here:
//   1. Local state mirrors Y.Text's toString() so React renders are
//      cheap (no observer per keystroke).
//   2. User typing applies the delta (insert/delete) to Y.Text. We
//      compute the smallest diff via a common-prefix / common-suffix
//      pass rather than a clear-and-rewrite — that preserves remote
//      collaborators' clock and lets concurrent inserts on either
//      side of the cursor merge cleanly.
//   3. Remote Y.Text updates (someone else typed) flush to the
//      input's value while preserving the local user's selection
//      range. Without that, every remote update would yank the
//      cursor to the end.
//
// Use case: phase 2 wires the project name; the same hook will pick
// up node content / choice text / character names in later phases.

import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { computeStringDiff } from '@wanderline/shared';

// Re-export so existing consumers (including the vitest harness that
// pins the diff behaviour) don't need to change their import path.
export { computeStringDiff };

/**
 * Walk a Y.Text event's delta and translate the user's selection
 * range to its equivalent position in the post-update string.
 *
 * Rules per delta op:
 *   - `retain n` advances the cursor by n unchanged characters.
 *   - `insert s` shifts everything at or after the cursor right by
 *     s.length. We treat `at the cursor` as 'inserts go BEFORE the
 *     cursor' so the caret stays on the same character.
 *   - `delete n` removes n chars starting at the current position;
 *     anything inside the deleted range collapses to the deletion
 *     point. We use `<=` for the start-position comparison so a
 *     deletion that consumes the character the cursor sits ON
 *     pulls the cursor back to the start.
 */
// exported for the vitest harness. The remote-update cursor
// preservation logic is easy to regress and hard to notice in
// two-tab spot checks (a wrong offset by 1 may not surface until a
// specific insert pattern hits it), so a direct unit test is worth
// pinning.
export function adjustSelectionForDelta(
  event: Y.YTextEvent,
  selStart: number,
  selEnd: number,
): { start: number; end: number } {
  let cursor = 0;
  let newStart = selStart;
  let newEnd = selEnd;
  for (const op of event.delta) {
    if (op.retain) {
      cursor += op.retain;
    } else if (op.insert) {
      const len = typeof op.insert === 'string' ? op.insert.length : 1;
      if (cursor <= newStart) newStart += len;
      if (cursor <= newEnd) newEnd += len;
      cursor += len;
    } else if (op.delete) {
      const delEnd = cursor + op.delete;
      if (newStart > cursor) newStart = Math.max(cursor, newStart - op.delete);
      if (newEnd > cursor) newEnd = Math.max(cursor, newEnd - op.delete);
      // cursor stays at `cursor` (delete doesn't advance it).
      void delEnd;
    }
  }
  return { start: newStart, end: newEnd };
}

type AnyTextElement = HTMLInputElement | HTMLTextAreaElement;

export interface UseYjsTextFieldResult {
  value: string;
  /** Pass as the input's `ref` so the hook can manage selection on remote updates.
   * Works on both <input> and <textarea> — selection APIs are identical. */
  inputRef: (el: AnyTextElement | null) => void;
  /** Pass as the input's `onChange` handler. */
  onChange: (event: React.ChangeEvent<AnyTextElement>) => void;
}

/**
 * Bind a string-valued <input> or <textarea> to a specific Y.Text.
 * The caller picks the Y.Text — could be a top-level
 * doc.getText('projectName') or a nested ref like
 * `doc.nodes.get(id).get('choices').get(i).get('text')`. Pass
 * `null` to render a disabled input while the doc is still loading.
 */
export function useYjsTextField(yText: Y.Text | null): UseYjsTextFieldResult {
  const inputElRef = useRef<AnyTextElement | null>(null);
  const inputRef = (el: AnyTextElement | null) => {
    inputElRef.current = el;
  };
  const yTextRef = useRef<Y.Text | null>(yText);
  const [value, setValue] = useState<string>(() => yText?.toString() ?? '');
  // Track whether the current `value` came from a remote update so
  // the next render restores the user's selection.
  const pendingSelectionRestoreRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    yTextRef.current = yText;
    if (!yText) {
      setValue('');
      return;
    }
    setValue(yText.toString());

    const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      const next = yText.toString();
      // For remote updates (transaction not driven by this client),
      // capture the input's current selection and adjust it for the
      // delta so the user's caret stays put. Without this, every
      // peer keystroke that lands while we're focused would yank the
      // caret to the end of the new string. The local-edit path
      // already populates pendingSelectionRestoreRef inside onChange,
      // so we ONLY do this work for non-local transactions.
      if (!transaction.local && inputElRef.current) {
        const el = inputElRef.current;
        const oldStart = el.selectionStart ?? next.length;
        const oldEnd = el.selectionEnd ?? next.length;
        const adjusted = adjustSelectionForDelta(event, oldStart, oldEnd);
        pendingSelectionRestoreRef.current = adjusted;
      }
      setValue((prev) => (prev === next ? prev : next));
    };
    yText.observe(observer);
    return () => {
      yText.unobserve(observer);
    };
  }, [yText]);

  // After a remote update reflows the value, restore the user's
  // selection. We capture it pre-update in onChange and after-render
  // here. This runs every render but only does work if the ref is
  // set.
  useEffect(() => {
    const sel = pendingSelectionRestoreRef.current;
    if (!sel || !inputElRef.current) return;
    try {
      inputElRef.current.setSelectionRange(sel.start, sel.end);
    } catch {
      // Some input types (e.g. number) don't support setSelectionRange.
    }
    pendingSelectionRestoreRef.current = null;
  });

  function onChange(event: React.ChangeEvent<AnyTextElement>) {
    const yText = yTextRef.current;
    if (!yText) return;
    const before = yText.toString();
    const after = event.target.value;
    if (before === after) return;
    const { at, deleteLen, insert: insertText } = computeStringDiff(before, after);

    // Save selection so the next render (post-observe) restores it.
    if (inputElRef.current) {
      pendingSelectionRestoreRef.current = {
        start: inputElRef.current.selectionStart ?? after.length,
        end: inputElRef.current.selectionEnd ?? after.length,
      };
    }

    const doc = yText.doc;
    const apply = () => {
      if (deleteLen > 0) yText.delete(at, deleteLen);
      if (insertText) yText.insert(at, insertText);
    };
    if (doc) {
      doc.transact(apply, 'local');
    } else {
      apply();
    }
  }

  return { value, inputRef, onChange };
}

/**
 * One-shot initializer: if the Y.Text is empty when the doc first
 * connects (i.e. nobody has populated it yet on the server), seed
 * it from a local fallback. Phase 4 will do this server-side from
 * the DB; until then this race-tolerant client init keeps the field
 * non-empty so users see their project's name on first load.
 *
 * The race acceptable: if two clients connect simultaneously and
 * both observe an empty Y.Text, both will write — but Yjs merges
 * the two inserts. The result will be "<name1><name2>" instead of
 * "<name1>"; users notice and edit. Phase 4 eliminates this.
 */
export function useYjsTextSeed(
  doc: Y.Doc | null,
  key: string,
  fallback: string,
  ready: boolean,
): void {
  const seededRef = useRef(false);
  useEffect(() => {
    if (!doc || !ready || seededRef.current) return;
    const yText = doc.getText(key);
    if (yText.length === 0 && fallback) {
      doc.transact(() => yText.insert(0, fallback), 'seed');
    }
    seededRef.current = true;
  }, [doc, key, fallback, ready]);
}
