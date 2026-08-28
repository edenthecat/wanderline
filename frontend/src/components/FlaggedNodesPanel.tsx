// Every open flag on the project, in one place.
//
// The per-passage badges tell you a passage is flagged once you're
// looking at it. This answers the other question — "what's outstanding
// on this story?" — which is the one you have when you sit down to
// work through a review rather than when you happen to scroll past.
//
// Mirrors StoryHealthPanel: a collapsible strip at the top of the
// story view, with node ids that jump the list to that passage.

import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveNodeFlag, type NodeFlag } from '../api/client';
import { FLAG_REASON_LABELS } from './flagLabels';

// How long a just-resolved record — the queued focus move, and the
// credit that lets the panel say "Flag resolved." — stays valid. Long
// enough for a refetch on a slow connection, short enough that neither
// can attach itself to an unrelated change minutes later.
const RECENT_RESOLVE_MS = 5000;

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
}

export default function FlaggedNodesPanel({
  projectId,
  flagsByNode,
  nodeIdSet,
  onJumpToNode,
  onFlagsChanged,
  truncated,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  // A set, not one id: gating every button on a single in-flight id
  // meant starting a second resolve re-enabled the first — letting it
  // fire twice and surface the backend's "already resolved" 404 for an
  // action that had actually succeeded — while finishing the first
  // cleared the second's spinner.
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Resolving a flag deletes the row the Resolve button lives in, so
  // focus had nowhere to go and fell to <body> — working through three
  // flags meant being thrown to the top of the document three times.
  // These refs let the removal hand focus to the next Resolve button.
  const resolveButtons = useRef(new Map<string, HTMLButtonElement>());
  const summaryRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<{
    resolvedId: string;
    nextId: string | null;
    at: number;
  } | null>(null);
  // Disabling a focused button blurs it, so `resolving` flipping drops
  // focus to <body> on its own. The success path re-homes it below; a
  // failure used to leave the author at the top of the document,
  // looking at an error about a button they'd have to hunt for again.
  const refocusOnFailure = useRef<string | null>(null);
  // When we last watched a resolve succeed. A drop in the count is
  // only ours to take credit for if it follows one of these closely;
  // anything older is a coincidence.
  const resolvedHere = useRef<number | null>(null);

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

  const total = entries.reduce((n, e) => n + e.flags.length, 0);

  // Every open flag id, in the order they are rendered. Resolving one
  // needs to know which button comes after it, and the effect below
  // needs to know when a resolved flag has actually left the list.
  const flagIds = useMemo(() => entries.flatMap(({ flags }) => flags.map((f) => f.id)), [entries]);
  const flagIdKey = flagIds.join('|');

  // The count changes silently as flags are resolved. This region is
  // rendered whether or not the panel is — so it can also speak at the
  // moment the last flag clears, which is when the panel disappears.
  // `truncated` rides along: the visible summary hedges the count and
  // the spoken one has to hedge it too, or a page count gets read out
  // as the total.
  const openSummary =
    `${total} open flag${total === 1 ? '' : 's'} across ${entries.length} passage${
      entries.length === 1 ? '' : 's'
    }` + (truncated ? ', showing the most recent.' : '.');
  const [announcement, setAnnouncement] = useState('');
  const lastTotal = useRef<number | null>(null);
  useEffect(() => {
    // Consumed on the first run after a resolve, whatever that run
    // finds — and only honoured if it is recent. Both guards matter,
    // and for different reasons. Resolving one flag while a
    // collaborator raises another leaves the total *and* the summary
    // string untouched, so `flagIdKey` is in the deps below to make
    // sure this effect still runs and spends the credit; and if the
    // refetch comes back byte-identical it doesn't run at all, so the
    // credit has to be able to go stale on its own. Without either,
    // the next empty list — which is also what a failed fetch looks
    // like — would be announced as a resolve that never happened.
    const stamp = resolvedHere.current;
    resolvedHere.current = null;
    const ours = stamp !== null && Date.now() - stamp <= RECENT_RESOLVE_MS;
    // The state on arrival isn't news; only announce changes to it.
    if (lastTotal.current === null) {
      lastTotal.current = total;
      return;
    }
    if (lastTotal.current === total) {
      // The count can hold steady across a resolve — someone else
      // raised one in the same breath. Staying silent there reads as
      // "your click did nothing", so say both halves.
      if (ours) setAnnouncement(`Flag resolved. ${openSummary}`);
      return;
    }
    lastTotal.current = total;
    if (total === 0) {
      // An empty list is also what a *failed* flags fetch looks like —
      // useNodeEditor swallows the error and reports `{}` — so "your
      // review queue is clear" is not ours to say. Report the thing we
      // watched succeed instead, and stay quiet when the emptiness
      // arrived from somewhere we can't vouch for.
      setAnnouncement(ours ? 'Flag resolved.' : '');
      return;
    }
    setAnnouncement(openSummary);
  }, [flagIdKey, total, openSummary]);

  // Once the resolved flag is gone from the list, re-home focus.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    // One shot, and time-boxed. If the refetch came back with the row
    // still in it the removal isn't ours to chase; and if the list
    // never changed at all this effect doesn't run, so the record has
    // to go stale on its own — otherwise some later, unrelated change
    // (a flag raised from NodeDetail, a collaborator's resolve) would
    // fire it and yank focus out of whatever the author moved on to.
    pendingFocus.current = null;
    if (Date.now() - pending.at > RECENT_RESOLVE_MS) return;
    if (flagIds.includes(pending.resolvedId)) return;
    const next = pending.nextId ? resolveButtons.current.get(pending.nextId) : undefined;
    // Next Resolve button, else the panel's own toggle, else the status
    // line — which is where you end up when that was the last flag and
    // the panel has unmounted around you. It reads "Flag resolved." and
    // is styled to become visible on focus, so landing there answers
    // the question for a sighted keyboard user as well as a spoken one.
    (next ?? summaryRef.current ?? statusRef.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagIdKey]);

  // A resolve that failed put focus nowhere. Hand it back to the button
  // once it is enabled again, so a retry is one keypress away.
  const resolvingKey = [...resolving].join('|');
  useEffect(() => {
    const id = refocusOnFailure.current;
    if (!id || resolving.has(id)) return;
    refocusOnFailure.current = null;
    resolveButtons.current.get(id)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvingKey]);

  async function resolve(flagId: string) {
    setResolving((prev) => new Set(prev).add(flagId));
    setError(null);
    try {
      await resolveNodeFlag(projectId, flagId);
      const at = flagIds.indexOf(flagId);
      resolvedHere.current = Date.now();
      pendingFocus.current = {
        resolvedId: flagId,
        // Prefer the flag below; at the end of the list, step back up.
        nextId: flagIds[at + 1] ?? flagIds[at - 1] ?? null,
        at: Date.now(),
      };
      onFlagsChanged();
    } catch (e) {
      refocusOnFailure.current = flagId;
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
  const statusRegion = (
    <div
      ref={statusRef}
      role="status"
      aria-live="polite"
      tabIndex={-1}
      className="sr-only sr-only-focusable"
      data-testid="flagged-panel-status"
    >
      {announcement}
    </div>
  );

  // Nothing outstanding means nothing to say. A panel reporting zero
  // would just be furniture above the story — but the status region
  // stays, so "you resolved the last one" still gets said.
  if (entries.length === 0) return statusRegion;

  return (
    <>
      {statusRegion}
      <section className="flagged-panel" data-testid="flagged-panel" aria-label="Flagged passages">
        <button
          type="button"
          ref={summaryRef}
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
                          ref={(el) => {
                            if (el) resolveButtons.current.set(f.id, el);
                            else resolveButtons.current.delete(f.id);
                          }}
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
    </>
  );
}
