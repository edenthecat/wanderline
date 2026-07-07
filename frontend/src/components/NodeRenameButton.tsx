import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

interface Props {
  /** Full node id (e.g. `foo` for a knot, `foo.bar` for a stitch). */
  nodeId: string;
  /** Fires the PATCH. Resolves once the parent has refetched — if it
   * rejects, the inline input shows the error and stays open. */
  onRename: (oldId: string, newId: string) => Promise<void>;
  /** Every id that already exists in the story. Used to short-circuit
   * a client-side "already taken" error before the round-trip. */
  nodeIdSet: Set<string>;
  /** Some node ids are structural — the current `startNode` and any
   * knot that owns stitches. We don't block renaming them (the
   * backend rewrites references), but we surface a small confirmation
   * so an accidental click doesn't cascade edits without warning.
   * Optional; default is "no confirmation needed". */
  confirmMessage?: string;
  /** Label used by screen readers to distinguish this button from
   * siblings when many render on one page. */
  ariaLabel?: string;
}

/**
 * rename affordance for a single node id. Renders as a
 * small edit button; on click, swaps to an inline text input + Save
 * / Cancel row. Handles the client-side validation the backend also
 * enforces (non-empty, differs, not taken) so the user gets a
 * synchronous error before the round-trip.
 */
export default function NodeRenameButton({
  nodeId,
  onRename,
  nodeIdSet,
  confirmMessage,
  ariaLabel,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(nodeId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function reset() {
    setEditing(false);
    setValue(nodeId);
    setError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next = value.trim();
    if (!next) {
      setError('Name cannot be empty.');
      return;
    }
    if (next === nodeId) {
      reset();
      return;
    }
    if (nodeIdSet.has(next)) {
      setError(`"${next}" is already used by another node.`);
      return;
    }
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setSaving(true);
    setError(null);
    try {
      await onRename(nodeId, next);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      reset();
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-xs node-rename-button"
        onClick={(e) => {
          // The parent header row is often a <button> or has its own
          // onClick (tree-expand toggle). Stop propagation so a
          // rename click doesn't also collapse the node.
          e.stopPropagation();
          setEditing(true);
        }}
        aria-label={ariaLabel ?? `Rename ${nodeId}`}
        title="Rename node"
      >
        {/* Pencil glyph — no icon dep. */}✎
      </button>
    );
  }

  return (
    <form
      className="node-rename-form"
      onSubmit={handleSubmit}
      // Stop the surrounding tree-expand button (a parent) from
      // grabbing pointerdown / click on the form.
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={saving}
        aria-label={`New name for ${nodeId}`}
        className="node-rename-input"
      />
      <button
        type="submit"
        className="btn btn-primary btn-xs"
        disabled={saving || value.trim() === '' || value.trim() === nodeId}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={reset} disabled={saving}>
        Cancel
      </button>
      {error && (
        <span className="node-rename-error text-danger text-sm" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
