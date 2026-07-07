import { useState } from 'react';
import type { OrphanedAudioFile } from '../api/client';

interface Props {
  files: OrphanedAudioFile[];
  // Single-file delete (parent refetches afterwards).
  onDelete: (id: string) => Promise<void>;
  // Bulk delete without per-file refetch — parent refetches once after
  // the loop completes. Falls back to onDelete if omitted.
  onDeleteSilent?: (id: string) => Promise<void>;
  // Called after a bulk-delete pass to trigger a single refetch.
  onBulkComplete?: () => Promise<void> | void;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / Math.pow(1000, i);
  return `${i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Surface audio files that exist on disk but aren't assigned
 * to any node, with name / size / upload date, plus a "Delete all
 * orphans" bulk-delete with a confirmation step. The single-file
 * Delete in the main audio list still works; this panel is for
 * cleanup sprees on imported projects.
 */
export default function OrphanedAudioPanel({
  files,
  onDelete,
  onDeleteSilent,
  onBulkComplete,
}: Props) {
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (files.length === 0) return null;

  const totalBytes = files.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);

  async function handleBulkDelete() {
    setBulkDeleting(true);
    setError(null);
    // Sequential delete so a mid-batch failure leaves the rest of the
    // list intact for retry, instead of firing N concurrent requests
    // against a server that may be rate-limiting. Use the silent
    // variant if the parent supplies one — without it, each delete
    // triggers a full coverage refetch (~3 GETs × N files).
    const deleteOne = onDeleteSilent ?? onDelete;
    try {
      for (const f of files) {
        await deleteOne(f.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete one or more files');
    } finally {
      // Refetch once at the end whether the loop completed or aborted
      // mid-way — the list needs to reconcile either way.
      try {
        await onBulkComplete?.();
      } catch {
        // bulk-complete errors are non-fatal; the next nav refetches
      }
      setBulkDeleting(false);
      setConfirmingBulk(false);
    }
  }

  return (
    <section className="orphaned-audio-panel" data-testid="orphaned-audio-panel">
      <div className="section-header">
        <h3>Orphaned audio files</h3>
        <span className="text-muted text-sm">
          {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
        </span>
      </div>
      <p className="text-muted text-sm">
        These audio files are uploaded to the project but aren’t assigned to any node — they take up
        storage and won’t appear in builds. Safe to delete unless you’re planning to reassign them.
      </p>
      {error && <div className="alert alert-error">{error}</div>}
      <table className="table">
        <thead>
          <tr>
            <th>Filename</th>
            <th>Size</th>
            <th>Uploaded</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id}>
              <td className="orphan-name">{f.name}</td>
              <td className="text-muted">{formatBytes(f.sizeBytes)}</td>
              <td className="text-muted">{formatDate(f.createdAt)}</td>
              <td className="orphan-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-danger"
                  onClick={() => {
                    // onDelete rethrows so the parent's error toast
                    // shows — catch the rejection here so React's
                    // onClick promise doesn't surface as an unhandled
                    // rejection (otherwise Sentry reports it twice).
                    onDelete(f.id).catch((err) => {
                      setError(err instanceof Error ? err.message : 'Failed to delete file');
                    });
                  }}
                  disabled={bulkDeleting}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="orphan-bulk-actions">
        {!confirmingBulk ? (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => setConfirmingBulk(true)}
          >
            Delete all {files.length} orphaned file{files.length === 1 ? '' : 's'}
          </button>
        ) : (
          <div className="orphan-bulk-confirm">
            <span className="text-sm" style={{ color: 'var(--color-danger)' }}>
              Permanently delete {files.length} file{files.length === 1 ? '' : 's'} (
              {formatBytes(totalBytes)})? This can’t be undone.
            </span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
            >
              {bulkDeleting ? 'Deleting…' : 'Confirm delete all'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirmingBulk(false)}
              disabled={bulkDeleting}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
