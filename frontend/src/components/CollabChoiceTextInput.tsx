// choice-text input that prefers the collaborative
// Y.Text when available, falling back to the existing uncontrolled
// + REST-PATCH path when the doc isn't reachable. The fallback
// matters for: initial render before useYjs has connected, the
// "?yjsDemo=0" case once we make collab opt-in for stability, and
// connection drops (where edits should still save via REST until
// the doc reconnects).
//
// Either path also fires the existing onLocalEdit callback so non-
// collab consumers (build pipeline, preview, validation) get a
// fresh story_graph snapshot via the existing REST handler.

import * as Y from 'yjs';
import { useYjsTextField } from '../hooks/useYjsTextField';

interface Props {
  /**
   * The Y.Text for this choice's text, if the doc is connected
   * and the node is in the Y.Doc. Null falls back to the
   * uncontrolled-input + REST-only path.
   */
  yText: Y.Text | null;
  /** Initial text — used when yText is null (uncontrolled path). */
  initialText: string;
  /** Fired on every keystroke for the REST PATCH shadow save. */
  onLocalEdit: (newText: string) => void;
  ariaLabel: string;
  className?: string;
}

export default function CollabChoiceTextInput({
  yText,
  initialText,
  onLocalEdit,
  ariaLabel,
  className,
}: Props) {
  // Hooks must be called unconditionally; the hook gracefully
  // handles a null Y.Text.
  const { value, inputRef, onChange } = useYjsTextField(yText);

  if (yText) {
    return (
      <input
        ref={inputRef}
        className={className}
        value={value}
        onChange={(e) => {
          onChange(e);
          onLocalEdit(e.target.value);
        }}
        aria-label={ariaLabel}
        data-testid="collab-choice-text"
        data-yjs-input="true"
      />
    );
  }

  // Uncontrolled fallback — preserves the original behavior so
  // anyone who lands here without a connected Y.Doc keeps the
  // existing UX. The key=initialText force-remount means a remote
  // change to ch.text (via REST refetch + re-render) is reflected
  // on the next render.
  return (
    <input
      key={initialText}
      className={className}
      defaultValue={initialText}
      onChange={(e) => onLocalEdit(e.target.value)}
      aria-label={ariaLabel}
      data-testid="legacy-choice-text"
    />
  );
}
