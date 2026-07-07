// Version history surface. Lists project_snapshots newest-first
// and lets the user create, restore, and delete them.
//
// A restore writes the snapshot back over project_stories +
// node_metadata server-side, then drops the live collab room. Any
// editor tabs that were connected to this project reconnect on
// their own and re-hydrate from the new row — no client-side
// reload needed beyond the parent refetching the project.

import { useCallback, useEffect, useState } from 'react';
import {
  fetchSnapshots,
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  type ProjectSnapshot,
} from '../api/client';

interface Props {
  projectId: string;
  /** Called after a successful restore so the parent can refetch. */
  onRestored: () => void;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function HistoryTab({ projectId, onRestored }: Props) {
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { snapshots } = await fetchSnapshots(projectId);
      setSnapshots(snapshots);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load snapshots');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    setBusy('create');
    setError(null);
    try {
      await createSnapshot(projectId, label.trim());
      setLabel('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create snapshot');
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore(snapshot: ProjectSnapshot) {
    const ok = window.confirm(
      `Restore "${snapshot.label}"? An automatic "Before restore" snapshot will be saved first, so this is reversible.`,
    );
    if (!ok) return;
    setBusy(`restore:${snapshot.id}`);
    setError(null);
    try {
      await restoreSnapshot(projectId, snapshot.id);
      await load();
      onRestored();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore snapshot');
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(snapshot: ProjectSnapshot) {
    if (!window.confirm(`Delete snapshot "${snapshot.label}"? This cannot be undone.`)) return;
    setBusy(`delete:${snapshot.id}`);
    setError(null);
    try {
      await deleteSnapshot(projectId, snapshot.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete snapshot');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="tab-panel history-tab" data-testid="history-tab">
      <header>
        <h2>Version history</h2>
        <p className="text-muted">
          Snapshots capture the story, ink source, and per-node metadata so you can roll back from a
          destructive change. Auto-snapshots are saved before risky operations like ink uploads or
          other restores.
        </p>
      </header>

      <div className="history-create">
        <input
          className="input"
          type="text"
          placeholder="Snapshot label (optional)"
          value={label}
          maxLength={200}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy === 'create'}
          aria-label="Snapshot label"
        />
        <button
          className="btn btn-primary"
          onClick={handleCreate}
          disabled={busy === 'create'}
          data-testid="snapshot-create-btn"
        >
          {busy === 'create' ? 'Saving…' : 'Save snapshot'}
        </button>
      </div>

      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : snapshots.length === 0 ? (
        <p className="text-muted">No snapshots yet.</p>
      ) : (
        <ul className="history-list" data-testid="snapshot-list">
          {snapshots.map((snap) => (
            <li key={snap.id} className="history-item" data-testid="snapshot-row">
              <div className="history-item-meta">
                <strong>{snap.label}</strong>
                <span className={`history-source history-source-${snap.source}`}>
                  {snap.source}
                </span>
                <span className="text-muted">
                  {formatWhen(snap.created_at)}
                  {snap.created_by_name ? ` · ${snap.created_by_name}` : ''}
                </span>
              </div>
              <div className="history-item-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => handleRestore(snap)}
                  disabled={busy === `restore:${snap.id}`}
                  data-testid="snapshot-restore-btn"
                >
                  {busy === `restore:${snap.id}` ? 'Restoring…' : 'Restore'}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => handleDelete(snap)}
                  disabled={busy === `delete:${snap.id}`}
                  data-testid="snapshot-delete-btn"
                >
                  {busy === `delete:${snap.id}` ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
