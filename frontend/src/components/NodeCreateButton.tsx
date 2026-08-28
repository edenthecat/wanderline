import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

interface Props {
  /** Label for the collapsed button, e.g. "Add knot" / "Add passage". */
  label: string;
  /**
   * Owning knot when this form creates a stitch. The typed name is a
   * BARE stitch name; the full id sent to the server is
   * `${parentId}.${name}`, matching how the graph keys stitches.
   * Omitted for a top-level knot / Twee passage.
   */
  parentId?: string;
  /**
   * Siblings the new passage can be placed after, in story order. Ink
   * falls through from a passage that ends without a divert into the
   * NEXT sibling, so this is a story decision — offered as a select
   * rather than always appending. Empty (the default) hides the
   * control and appends.
   */
  siblings?: string[];
  /**
   * Anchor that means "first" — the owning knot, which the server
   * reads as "immediately after the knot header". A knot runs by its
   * lowest-lineNumber stitch, so this is the slot that gives a chapter
   * a new opening scene; without it the first position would be
   * unreachable from the editor. Omitted for top-level nodes, where
   * "first" would mean changing the story's start passage — a
   * different operation with no endpoint.
   */
  firstAnchorId?: string;
  /** Fires the POST. Resolves once the parent has refetched. */
  onCreate: (
    nodeId: string,
    options?: { content?: string; afterNodeId?: string | null },
  ) => Promise<void>;
  /** Every id already in the story, for a synchronous "taken" error. */
  nodeIdSet: Set<string>;
  /** What a sibling is called in this project's vocab, for the label
   * on the placement select ("Place after"). */
  siblingNoun?: string;
}

/**
 * Inline "add a passage" form. Collapsed to a button until used, in
 * the same shape as NodeRenameButton so the two read as one family of
 * affordances on the node header.
 *
 * Deliberately creates an EMPTY passage: the author names it and
 * places it here, then writes the prose in the detail panel that every
 * other content edit already goes through. Asking for a name and a
 * body in one cramped inline form gets neither right.
 */
export default function NodeCreateButton({
  label,
  parentId,
  siblings = [],
  firstAnchorId,
  onCreate,
  nodeIdSet,
  siblingNoun = 'node',
}: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [afterId, setAfterId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function reset() {
    setOpen(false);
    setName('');
    setAfterId('');
    setError(null);
  }

  const fullId = (raw: string) => (parentId ? `${parentId}.${raw}` : raw);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name cannot be empty.');
      return;
    }
    const id = fullId(trimmed);
    if (nodeIdSet.has(id)) {
      setError(`"${id}" already exists.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate(id, afterId ? { afterNodeId: afterId } : undefined);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create');
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

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={(e) => {
          // Node headers are themselves buttons (tree-expand); don't
          // let opening this form also collapse the row.
          e.stopPropagation();
          setOpen(true);
        }}
      >
        + {label}
      </button>
    );
  }

  return (
    <form className="node-create-form" onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={saving}
        placeholder={parentId ? 'stitch name' : 'name'}
        aria-label={label}
        className="node-rename-input"
      />
      {(siblings.length > 0 || firstAnchorId) && (
        <label className="node-create-placement">
          Place after
          <select
            className="select select-sm"
            value={afterId}
            onChange={(e) => setAfterId(e.target.value)}
            disabled={saving}
            aria-label={`Place after which ${siblingNoun}`}
          >
            <option value="">(last)</option>
            {firstAnchorId && <option value={firstAnchorId}>(first)</option>}
            {siblings.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="btn btn-primary btn-xs" disabled={saving || !name.trim()}>
        {saving ? 'Adding…' : 'Add'}
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
