// "Flag this passage" for the preview toolbar.
//
// A reviewer notices problems while listening, and the passage playing
// right now is the one they mean. Making them remember an id and go
// find it in the node list afterwards is how a noticed problem becomes
// a forgotten one — so the control names the current passage and files
// against it directly.

import { useState } from 'react';
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
  const [reason, setReason] = useState<NodeFlagReason>('not_working');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justFlagged, setJustFlagged] = useState<string | null>(null);

  async function submit() {
    if (!nodeId) return;
    setSaving(true);
    setError(null);
    try {
      await createNodeFlag(projectId, { nodeId, reason, note: note.trim() || undefined });
      setJustFlagged(nodeId);
      setOpen(false);
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
        onClick={() => setOpen((o) => !o)}
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

      {open && nodeId && (
        <div className="flag-control-popover" role="group" aria-label="Flag this passage">
          <p className="text-sm">
            Flagging <code>{nodeId}</code>
          </p>
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
              onClick={() => setOpen(false)}
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
