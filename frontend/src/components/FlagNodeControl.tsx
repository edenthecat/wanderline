// "Flag this passage" for the preview toolbar.
//
// A reviewer notices problems while listening, and the passage playing
// right now is the one they mean. Making them remember an id and go
// find it in the node list afterwards is how a noticed problem becomes
// a forgotten one — so the control names the current passage and files
// against it directly.

import { useEffect, useState } from 'react';
import { createNodeFlag, type NodeFlagReason } from '../api/client';

const REASONS: { value: NodeFlagReason; label: string }[] = [
  { value: 'not_working', label: "Doesn't work correctly" },
  { value: 'incorrect_audio', label: 'Incorrect audio' },
  { value: 'needs_text_edit', label: 'Needs a text edit' },
];

interface Props {
  projectId: string;
  /** The passage currently on screen, reported by the player. */
  nodeId: string | null;
  onFlagged?: () => void;
}

export default function FlagNodeControl({ projectId, nodeId, onFlagged }: Props) {
  const [open, setOpen] = useState(false);
  // The passage this popover is filing against, captured when it
  // opened. `nodeId` is live — the player pushes a new one whenever
  // playback moves, and it moves on its own with auto-advance. Reading
  // it at submit time meant a reviewer who heard a problem, opened the
  // form and started typing could file the report against whatever
  // passage happened to be playing by the time they pressed the button,
  // which is exactly the mix-up the feature exists to prevent.
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState<NodeFlagReason>('not_working');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justFlagged, setJustFlagged] = useState<string | null>(null);

  // Finding: the confirmation used to persist indefinitely, so ten
  // passages later the toolbar still read "Flagged chapter1.intro" —
  // indistinguishable from having just flagged the current one.
  useEffect(() => {
    setJustFlagged(null);
  }, [nodeId]);

  function openPopover() {
    setTarget(nodeId);
    setError(null);
    setOpen(true);
  }

  function closePopover() {
    setOpen(false);
    setTarget(null);
    // Otherwise a failure from a previous attempt greets the next one.
    setError(null);
  }

  async function submit() {
    if (!target) return;
    setSaving(true);
    setError(null);
    try {
      await createNodeFlag(projectId, { nodeId: target, reason, note: note.trim() || undefined });
      setJustFlagged(target);
      setOpen(false);
      setTarget(null);
      setNote('');
      onFlagged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not raise the flag');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flag-control">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => (open ? closePopover() : openPopover())}
        // Disabled until the player reports a passage: flagging
        // "nothing" would file a report nobody can act on.
        disabled={!nodeId}
        title={nodeId ? `Flag ${nodeId}` : 'Start the preview to flag a passage'}
        aria-expanded={open}
      >
        Flag this passage
      </button>

      {justFlagged && !open && (
        <span className="flag-control-confirm text-muted text-sm" role="status">
          Flagged <code>{justFlagged}</code>
        </span>
      )}

      {open && target && (
        <div className="flag-control-popover" role="group" aria-label="Flag this passage">
          <p className="text-sm">
            Flagging <code>{target}</code>
          </p>
          {/* The preview kept playing while this was open. Say so
              rather than silently filing against either passage — the
              reviewer is the only one who knows which they meant. */}
          {nodeId && nodeId !== target && (
            <p className="flag-control-moved text-sm">
              The preview has moved on to <code>{nodeId}</code>. This will still be filed against{' '}
              <code>{target}</code>.{' '}
              <button type="button" className="btn-link" onClick={() => setTarget(nodeId)}>
                Flag {nodeId} instead
              </button>
            </p>
          )}
          <div className="flag-control-reasons">
            {REASONS.map((r) => (
              <label key={r.value} className="flag-control-reason">
                <input
                  type="radio"
                  name="flag-reason"
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                />
                <span>{r.label}</span>
              </label>
            ))}
          </div>
          <textarea
            className="flag-control-note"
            value={note}
            rows={2}
            maxLength={2000}
            placeholder="Anything worth remembering (optional)"
            aria-label="Flag note"
            onChange={(e) => setNote(e.target.value)}
          />
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <div className="flag-control-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void submit()}
              disabled={saving}
            >
              {saving ? 'Flagging…' : 'Flag it'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={closePopover}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
