import { useMemo, useState } from 'react';

interface Props {
  /** Full node id (e.g. `foo` for a knot, `foo.bar` for a stitch). */
  nodeId: string;
  /**
   * Everything that goes with it — for an Ink knot, its stitches. Used
   * for the warning copy and to keep those ids out of the "point them
   * at" list (the server rejects a replacement it is about to delete).
   * Should include `nodeId` itself.
   */
  doomedIds: string[];
  /** Ids that link or divert into this passage today, for the warning
   * and to decide whether the repoint control is needed up front. */
  referrers: string[];
  /** Every id in the story, for the replacement-target select. */
  allNodeIds: string[];
  /** Fires the DELETE. Resolves once the parent has refetched. */
  onDelete: (nodeId: string, repointTo?: string) => Promise<void>;
  /** Set when deleting is refused before it is attempted — the story's
   * start passage has no replacement mechanism. Renders the button
   * disabled with this as its tooltip. */
  blockedReason?: string;
  /** What a passage is called in this project's vocab, for the copy. */
  noun?: string;
}

/**
 * Delete affordance for one passage.
 *
 * The dialog is inline rather than `window.confirm` because a delete
 * that breaks links needs an ANSWER, not just an acknowledgement: when
 * other passages point here the author picks where those links go, and
 * that choice is sent with the delete so the two happen in one
 * transaction. The server refuses outright without it, so this control
 * is the only path that doesn't dead-end.
 *
 * The referrer list is computed from the local graph, which resolves
 * link targets by exact match only. A legacy Ink graph can hold a bare
 * `-> scene` that resolves to a stitch, which the server catches and
 * this doesn't — hence the server's 409 also switches the repoint
 * control on, rather than the control being purely client-driven.
 */
export default function NodeDeleteButton({
  nodeId,
  doomedIds,
  referrers,
  allNodeIds,
  onDelete,
  blockedReason,
  noun = 'node',
}: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Turned on by a server 409 for referrers we couldn't see locally.
  const [repointForced, setRepointForced] = useState(false);
  const [repointTo, setRepointTo] = useState('END');

  const doomedSet = useMemo(() => new Set(doomedIds), [doomedIds]);
  const replacementOptions = useMemo(
    () => allNodeIds.filter((id) => !doomedSet.has(id)),
    [allNodeIds, doomedSet],
  );
  const needsRepoint = referrers.length > 0 || repointForced;
  const childCount = Math.max(doomedIds.length - 1, 0);

  function reset() {
    setOpen(false);
    setSaving(false);
    setError(null);
    setRepointForced(false);
    setRepointTo('END');
  }

  async function handleDelete() {
    setSaving(true);
    setError(null);
    try {
      await onDelete(nodeId, needsRepoint ? repointTo : undefined);
      reset();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      setError(message);
      // The server found referrers we didn't — reveal the control so
      // the retry can answer the question it asked.
      if (/point/i.test(message)) setRepointForced(true);
      setSaving(false);
    }
  }

  if (blockedReason) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-xs node-delete-button"
        disabled
        title={blockedReason}
        aria-label={`Delete ${nodeId} (unavailable)`}
      >
        🗑
      </button>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-xs node-delete-button"
        onClick={(e) => {
          // Node headers are themselves buttons (tree-expand).
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Delete ${nodeId}`}
        title={`Delete ${noun}`}
      >
        🗑
      </button>
    );
  }

  return (
    <div
      className="node-delete-confirm"
      role="group"
      aria-label={`Delete ${nodeId}`}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="node-delete-prompt">
        Delete <code>{nodeId}</code>
        {childCount > 0 && ` and its ${childCount} sub-node${childCount === 1 ? '' : 's'}`}?
      </span>
      {needsRepoint && (
        <label className="node-delete-repoint">
          {referrers.length > 0
            ? `${referrers.length} ${referrers.length === 1 ? 'passage points' : 'passages point'} here — send them to`
            : 'Send the links that point here to'}
          <select
            className="select select-sm"
            value={repointTo}
            onChange={(e) => setRepointTo(e.target.value)}
            disabled={saving}
            aria-label="Replacement target"
          >
            <option value="END">END (story ends there)</option>
            <option value="DONE">DONE</option>
            {replacementOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className="btn btn-danger btn-xs"
        onClick={handleDelete}
        disabled={saving}
      >
        {saving ? 'Deleting…' : 'Delete'}
      </button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={reset} disabled={saving}>
        Cancel
      </button>
      {error && (
        <span className="node-rename-error text-danger text-sm" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
