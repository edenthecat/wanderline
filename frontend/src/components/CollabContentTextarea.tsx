// Multi-line collaborative input for node body content paragraphs.
// Same shape as CollabChoiceTextInput, but uses a <textarea> because
// content lines can be arbitrarily long narrator prose.
//
// Falls back to an uncontrolled textarea + REST PATCH when the Y.Doc
// isn't reachable (initial render before the WS sync arrives, or a
// connection drop) — peers still get their edits saved via the
// shadow REST handler.

import { useCallback, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { useYjsTextField } from '../hooks/useYjsTextField';

// Resize a textarea to fit its current content, clamped between
// minRows and maxRows. Called from useAutosize for the collab path
// (value-driven) and on every keystroke in the fallback path
// (value isn't React-tracked there, so we measure imperatively).
function resizeTextarea(el: HTMLTextAreaElement, minRows = 2, maxRows = 18) {
  el.style.height = 'auto';
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
  const padding =
    parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
  const target = Math.min(
    Math.max(el.scrollHeight, lineHeight * minRows + padding),
    lineHeight * maxRows + padding,
  );
  el.style.height = `${target}px`;
}

interface Props {
  /** The Y.Text for this content line, if the doc is connected
   * and the node is in the Y.Doc. Null falls back to the
   * uncontrolled-textarea + REST-only path. */
  yText: Y.Text | null;
  /** Initial text — used when yText is null (uncontrolled path). */
  initialText: string;
  /** Fired on every keystroke for the REST PATCH shadow save. */
  onLocalEdit: (newText: string) => void;
  ariaLabel: string;
  className?: string;
}

// Run resizeTextarea on the ref whenever `value` changes. Used by
// the collab path where Y.Text → React state drives the size.
function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    resizeTextarea(el);
  }, [ref, value]);
}

export default function CollabContentTextarea({
  yText,
  initialText,
  onLocalEdit,
  ariaLabel,
  className,
}: Props) {
  const { value, inputRef, onChange } = useYjsTextField(yText);
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  // Collab path: Y.Text drives `value` so autosize runs whenever
  // value changes. Fallback path runs the same effect once on mount
  // (initialText is the seed) and from there onInput keeps it sized.
  useAutosize(localRef, yText ? value : initialText);

  // Single keystroke handler that always resizes the textarea, then
  // either fires the collab onChange or the fallback path's
  // onLocalEdit. Keeps the two paths visually consistent.
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    resizeTextarea(e.currentTarget);
  }, []);

  if (yText) {
    return (
      <textarea
        ref={(el) => {
          inputRef(el);
          localRef.current = el;
        }}
        className={className}
        value={value}
        onInput={handleInput}
        onChange={(e) => {
          onChange(e);
          onLocalEdit(e.target.value);
        }}
        aria-label={ariaLabel}
        rows={2}
        data-testid="collab-content-textarea"
        data-yjs-input="true"
      />
    );
  }

  return (
    <textarea
      key={initialText}
      ref={localRef}
      className={className}
      defaultValue={initialText}
      onInput={handleInput}
      onChange={(e) => onLocalEdit(e.target.value)}
      aria-label={ariaLabel}
      rows={2}
      data-testid="legacy-content-textarea"
    />
  );
}
