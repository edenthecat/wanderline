import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelBuild,
  deleteBuild,
  fetchBuilds,
  pinBuild,
  startBuild,
  type Build,
} from '../api/client';

interface Props {
  projectId: string;
  hasStory: boolean;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / Math.pow(1000, i);
  // Keep one decimal for KB+, no decimal for B
  return `${i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

// generate a per-click Idempotency-Key so a mid-flight
// network failure + retry maps to the same server-side row. crypto
// is available in every modern browser we support.
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for the rare browser without crypto.randomUUID — good
  // enough for uniqueness within a session.
  return `wl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function BuildsTab({ projectId, hasStory }: Props) {
  const [builds, setBuilds] = useState<Build[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [maxBuilds, setMaxBuilds] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [label, setLabel] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // track which build the user is currently cancelling /
  // pinning so we can disable the row's action buttons in flight.
  // A Set matches the multi-row shape (two cancels back-to-back
  // shouldn't step on each other).
  const [rowBusy, setRowBusy] = useState<Set<string>>(new Set());
  // Persist the idempotency key across retries of the SAME click.
  // Ref (not state) because we mutate it inside the click handler
  // without needing a re-render.
  const pendingKey = useRef<string | null>(null);

  const loadBuilds = useCallback(async () => {
    try {
      const data = await fetchBuilds(projectId);
      setBuilds(data.builds);
      setCanCreate(data.canCreateBuild);
      setMaxBuilds(data.maxBuilds);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load builds');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadBuilds();
  }, [loadBuilds]);

  // Poll for active builds — depend on derived boolean to avoid timer churn
  const activeBuild = builds.find((b) => b.status === 'pending' || b.status === 'processing');
  const hasActiveBuild = activeBuild !== undefined;
  useEffect(() => {
    if (!hasActiveBuild) return;

    const interval = setInterval(loadBuilds, 5000);
    return () => clearInterval(interval);
  }, [hasActiveBuild, loadBuilds]);

  async function handleStartBuild() {
    setStarting(true);
    setError(null);
    setNotice(null);
    // Reuse an existing pending key so a mid-flight network flake +
    // retry (either automatic in the fetch layer or user-triggered by
    // hitting Start again) replays the same server-side row inside
    // the backend's Idempotency-Key window. Cleared ONLY on success
    // below; a user hitting Start again after a soft failure
    // deliberately keeps the same key so the server can either
    // resurface the earlier build or accept the new POST as the
    // same intent.
    if (!pendingKey.current) pendingKey.current = newIdempotencyKey();
    try {
      const outcome = await startBuild(projectId, label || undefined, pendingKey.current);
      setLabel('');
      pendingKey.current = null;
      if (outcome.idempotentHit) {
        setNotice(
          `We already have this exact request queued — showing build #${outcome.build.buildNumber} again.`,
        );
      } else if (outcome.dedupHit) {
        setNotice(
          `No source changes since build #${outcome.build.buildNumber} — reusing that artifact instead of rebuilding.`,
        );
      }
      await loadBuilds();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start build');
    } finally {
      setStarting(false);
    }
  }

  function setBusy(buildId: string, busy: boolean) {
    setRowBusy((prev) => {
      const next = new Set(prev);
      if (busy) next.add(buildId);
      else next.delete(buildId);
      return next;
    });
  }

  async function handleDelete(buildId: string) {
    if (!confirm('Delete this build? It will be recoverable for the next 24 hours.')) return;
    setBusy(buildId, true);
    try {
      await deleteBuild(projectId, buildId);
      if (expandedId === buildId) setExpandedId(null);
      await loadBuilds();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(buildId, false);
    }
  }

  async function handleCancel(buildId: string) {
    if (!confirm('Cancel this build? The pipeline will stop as soon as it checks in.')) return;
    setBusy(buildId, true);
    try {
      await cancelBuild(projectId, buildId);
      await loadBuilds();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setBusy(buildId, false);
    }
  }

  async function handleTogglePin(b: Build) {
    setBusy(b.id, true);
    try {
      // Send the desired next state explicitly so a double-click
      // doesn't flip the value we didn't ask for. Backend also
      // supports body-less toggle, but explicit is safer here.
      await pinBuild(projectId, b.id, !b.pinned);
      await loadBuilds();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pin toggle failed');
    } finally {
      setBusy(b.id, false);
    }
  }

  function statusBadge(status: string) {
    const cls: Record<string, string> = {
      pending: 'badge-gray',
      processing: 'badge-blue',
      completed: 'badge-green',
      failed: 'badge-red',
      // cancelled reads as a soft-terminal state (user
      // intentionally stopped it), so we tone it down vs. failed.
      cancelled: 'badge-gray',
    };
    return <span className={`badge ${cls[status] || 'badge-gray'}`}>{status}</span>;
  }

  if (loading) return <div className="page-loader">Loading builds...</div>;

  return (
    <div className="tab-panel">
      <div className="section-header">
        <h2>Builds</h2>
        <p className="text-muted text-sm">
          {builds.length} of {maxBuilds} builds stored. Older non-pinned builds are auto-deleted
          when the cap is reached.
        </p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
        </div>
      )}

      {activeBuild && (
        <div className="alert alert-info" role="status">
          <strong>
            Build #{activeBuild.buildNumber} {activeBuild.status}…
          </strong>
          {activeBuild.message && <span> — {activeBuild.message}</span>}
        </div>
      )}

      {!hasStory ? (
        <div className="empty-state">
          <p>Upload a story file before creating builds.</p>
        </div>
      ) : (
        <div className="build-trigger card">
          <div className="build-trigger-row">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Build label (optional)"
              className="build-label-input"
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleStartBuild}
              disabled={!canCreate || starting}
            >
              {starting ? 'Starting…' : 'Start build'}
            </button>
          </div>
          {!canCreate && builds.length >= maxBuilds && (
            <p className="text-muted text-sm">
              Maximum {maxBuilds} builds reached and every build is pinned. Unpin one to make room.
            </p>
          )}
        </div>
      )}

      {builds.length === 0 ? (
        <div className="empty-state">
          <p>No builds yet.</p>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Label</th>
              <th>Status</th>
              <th>Size</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => {
              const isExpanded = expandedId === b.id;
              const canExpand = b.status === 'completed' && b.totalSizeBytes !== null;
              const isActive = b.status === 'pending' || b.status === 'processing';
              const isTerminal =
                b.status === 'completed' || b.status === 'failed' || b.status === 'cancelled';
              const busy = rowBusy.has(b.id);
              return (
                <Fragment key={b.id}>
                  <tr>
                    <td>
                      {b.buildNumber}
                      {b.pinned && (
                        <span
                          className="pin-marker"
                          title="Pinned — exempt from auto-cull"
                          aria-label="Pinned"
                        >
                          {' '}
                          ★
                        </span>
                      )}
                    </td>
                    <td>
                      {b.label || <span className="text-muted">—</span>}
                      {b.message && b.status !== 'completed' && (
                        <div className="text-muted text-sm">{b.message}</div>
                      )}
                    </td>
                    <td>{statusBadge(b.status)}</td>
                    <td className="text-muted">{formatBytes(b.totalSizeBytes)}</td>
                    <td className="text-muted">{new Date(b.createdAt).toLocaleString()}</td>
                    <td className="build-actions">
                      {canExpand && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setExpandedId(isExpanded ? null : b.id)}
                          aria-expanded={isExpanded}
                          aria-controls={`build-details-${b.id}`}
                        >
                          {isExpanded ? 'Hide' : 'Details'}
                        </button>
                      )}
                      {b.status === 'completed' && (
                        <>
                          {/*: per-build preview replays the player
                              against the story snapshot saved at build
                              completion. Opens in a new tab. */}
                          <a
                            href={`/api/projects/${projectId}/builds/${b.id}/preview`}
                            className="btn btn-ghost btn-sm"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Preview
                          </a>
                          <a
                            href={`/api/projects/${projectId}/builds/${b.id}/download`}
                            className="btn btn-ghost btn-sm"
                            download
                          >
                            Download
                          </a>
                        </>
                      )}
                      {isActive && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-danger"
                          onClick={() => handleCancel(b.id)}
                          disabled={busy}
                          title="Stop this build"
                        >
                          Cancel
                        </button>
                      )}
                      {isTerminal && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleTogglePin(b)}
                          disabled={busy}
                          aria-pressed={b.pinned}
                          title={
                            b.pinned
                              ? 'Unpin — allow auto-cull to remove this build'
                              : 'Pin — prevent auto-cull from removing this build'
                          }
                        >
                          {b.pinned ? '★ Pinned' : '☆ Pin'}
                        </button>
                      )}
                      {isTerminal && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-danger"
                          onClick={() => handleDelete(b.id)}
                          disabled={busy}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="build-details-row">
                      <td colSpan={6} id={`build-details-${b.id}`}>
                        <dl className="build-details">
                          <div>
                            <dt>Audio</dt>
                            <dd>{formatBytes(b.audioSizeBytes)}</dd>
                          </div>
                          <div>
                            <dt>Code &amp; assets</dt>
                            <dd>{formatBytes(b.codeSizeBytes)}</dd>
                          </div>
                          <div>
                            <dt>Total (archive)</dt>
                            <dd>{formatBytes(b.totalSizeBytes)}</dd>
                          </div>
                          {b.completedAt && (
                            <div>
                              <dt>Completed</dt>
                              <dd>{new Date(b.completedAt).toLocaleString()}</dd>
                            </div>
                          )}
                          {b.playerBundleVersion && (
                            <div>
                              <dt>Player bundle</dt>
                              <dd className="text-mono">{b.playerBundleVersion}</dd>
                            </div>
                          )}
                          {b.attemptCount > 1 && (
                            <div>
                              <dt>Attempts</dt>
                              <dd>{b.attemptCount}</dd>
                            </div>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="text-muted text-sm build-preview-note">
        Each completed build has a Preview link that replays the player against the story snapshot
        captured at build time. Audio is resolved against the project&apos;s current audio files, so
        deleted-since-build clips may be silent.
      </p>
    </div>
  );
}
