// Every open flag on the project, in one place.
//
// The per-passage badges tell you a passage is flagged once you're
// looking at it. This answers the other question — "what's outstanding
// on this story?" — which is the one you have when you sit down to
// work through a review rather than when you happen to scroll past.
//
// Mirrors StoryHealthPanel: a collapsible strip at the top of the
// story view, with node ids that jump the list to that passage.

import { useMemo, useState } from 'react';
import { resolveNodeFlag, type NodeFlag } from '../api/client';
import { FLAG_REASON_LABELS } from './flagLabels';
import { PANEL_ANCHORS } from '../lib/panelAnchors';

interface Props {
  projectId: string;
  /** Open flags keyed by the passage they were raised against. */
  flagsByNode: Record<string, NodeFlag[]>;
  /** Node ids that exist in the current story graph. */
  nodeIdSet: Set<string>;
  onJumpToNode: (nodeId: string) => void;
  onFlagsChanged: () => void;
  /** The server capped the list; say so rather than letting the cap
   * read as the total. */
  truncated?: boolean;
  /** Start open. Read once, at mount: set when the Ship tab's
   * readiness summary sent the author here for this count, and being
   * scrolled to a collapsed one-line strip is not an answer. StoryTab
   * unmounts with the tab, so every arrival is a fresh mount. */
  startExpanded?: boolean;
}

export default function FlaggedNodesPanel({
  projectId,
  flagsByNode,
  nodeIdSet,
  onJumpToNode,
  onFlagsChanged,
  truncated,
  startExpanded = false,
}: Props) {
  const [expanded, setExpanded] = useState(startExpanded);
  // A set, not one id: gating every button on a single in-flight id
  // meant starting a second resolve re-enabled the first — letting it
  // fire twice and surface the backend's "already resolved" 404 for an
  // action that had actually succeeded — while finishing the first
  // cleared the second's spinner.
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const entries = useMemo(() => {
    return (
      Object.entries(flagsByNode)
        .filter(([, flags]) => flags.length > 0)
        .map(([nodeId, flags]) => ({
          nodeId,
          flags,
          // A flag on a passage the story no longer has can't be jumped
          // to and can't be fixed in place, so it's called out rather
          // than left looking like the others.
          orphaned: !nodeIdSet.has(nodeId),
        }))
        // Orphans first — they need a decision, not just an edit.
        .sort((a, b) =>
          a.orphaned === b.orphaned ? a.nodeId.localeCompare(b.nodeId) : a.orphaned ? -1 : 1,
        )
    );
  }, [flagsByNode, nodeIdSet]);

  // Nothing outstanding means nothing to say. A panel reporting zero
  // would just be furniture above the story.
  if (entries.length === 0) return null;

  const total = entries.reduce((n, e) => n + e.flags.length, 0);

  async function resolve(flagId: string) {
    setResolving((prev) => new Set(prev).add(flagId));
    setError(null);
    try {
      await resolveNodeFlag(projectId, flagId);
      onFlagsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not resolve');
    } finally {
      setResolving((prev) => {
        const next = new Set(prev);
        next.delete(flagId);
        return next;
      });
    }
  }

  const bodyId = 'flagged-nodes-body';
  return (
    <section
      id={PANEL_ANCHORS.flaggedNodes}
      className="flagged-panel"
      data-testid="flagged-panel"
      aria-label="Flagged passages"
    >
      <button
        type="button"
        className="flagged-panel-summary"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
      >
        <span className="flagged-panel-toggle" aria-hidden="true">
          {expanded ? '▼' : '▶'}
        </span>
        <span className="badge badge-red">
          {total} open flag{total === 1 ? '' : 's'}
        </span>
        <span className="text-sm text-muted">
          across {entries.length} passage{entries.length === 1 ? '' : 's'}
          {truncated && ' (showing the most recent)'}
        </span>
      </button>

      {expanded && (
        <div id={bodyId} className="flagged-panel-body">
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <ul className="flagged-panel-list">
            {entries.map(({ nodeId, flags, orphaned }) => (
              <li key={nodeId} className="flagged-panel-node">
                <div className="flagged-panel-node-head">
                  {orphaned ? (
                    <span className="flagged-panel-orphan">
                      <code>{nodeId}</code>
                      <span className="badge badge-gray">no longer in story</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => onJumpToNode(nodeId)}
                      aria-label={`Jump to ${nodeId}`}
                    >
                      <code>{nodeId}</code>
                    </button>
                  )}
                </div>
                <ul className="flagged-panel-flags">
                  {flags.map((f) => (
                    <li key={f.id} className="flagged-panel-flag">
                      <div className="flagged-panel-flag-body">
                        <strong>{FLAG_REASON_LABELS[f.reason] ?? f.reason}</strong>
                        {f.note && <p className="flagged-panel-note">{f.note}</p>}
                        <p className="text-sm text-muted">
                          {f.createdByName ? `${f.createdByName} · ` : ''}
                          {new Date(f.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => void resolve(f.id)}
                        disabled={resolving.has(f.id)}
                        aria-label={`Resolve ${FLAG_REASON_LABELS[f.reason] ?? f.reason} on ${nodeId}`}
                      >
                        {resolving.has(f.id) ? 'Saving…' : 'Resolve'}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
