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
  const panelRef = useRef<HTMLElement | null>(null);
  const summaryRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  // A queue, not a slot. `resolving` is deliberately a Set so a second
  // resolve can start while the first is in flight, and each refetch
  // removes one row — so each needs its own record of where focus
  // should go, or the second removal finds nothing queued and drops
  // focus to <body>, which is the whole bug.
  const pendingFocus = useRef<{ resolvedId: string; nextId: string | null; at: number }[]>([]);
  // Disabling a focused button blurs it, so `resolving` flipping drops
  // focus to <body> on its own. The success path re-homes it below; a
  // failure used to leave the author at the top of the document,
  // looking at an error about a button they'd have to hunt for again.
  const refocusOnFailure = useRef<string | null>(null);
  // One timestamp per resolve we watched succeed, spent one per
  // attributable change. A single slot would let two quick resolves
  // share one credit: the first refetch spends it and the second — the
  // one that empties the queue — reads as a change we can't vouch for
  // and says nothing at all.
  const resolveCredits = useRef<number[]>([]);

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
    // Credits expire on their own: a resolve can't vouch for a change
    // that lands minutes later. They also have to be spendable on a
    // change that leaves the count flat — resolving one flag while a
    // collaborator raises another moves neither the total nor the
    // summary string, which is why `flagIdKey` is in the deps.
    const now = Date.now();
    resolveCredits.current = resolveCredits.current.filter((t) => now - t <= RECENT_RESOLVE_MS);
    const spendCredit = () => resolveCredits.current.shift() !== undefined;

    // The state on arrival isn't news; only announce changes to it.
    if (lastTotal.current === null) {
      lastTotal.current = total;
      return;
    }
    const prev = lastTotal.current;
    if (prev === total) {
      // Staying silent when the count holds steady across a resolve
      // reads as "your click did nothing", so say both halves.
      if (spendCredit()) setAnnouncement(`Flag resolved. ${openSummary}`);
      return;
    }
    lastTotal.current = total;
    const ours = total < prev && spendCredit();
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

  // Re-homing focus is only a kindness while the author is still here.
  // A refetch can land a second or two later — the budget below is
  // sized for a slow connection, which is exactly the window in which
  // they may have clicked into the source editor and started typing.
  // Pulling focus onto a Resolve button mid-keystroke would put the
  // next Space or Enter on an unrelated flag. After a disable-blur
  // focus sits on <body>, which is ours to reclaim; anywhere outside
  // the panel is not.
  function mayTakeFocus() {
    const active = document.activeElement;
    if (!active || active === document.body) return true;
    if (active === statusRef.current) return true;
    return panelRef.current?.contains(active) ?? false;
  }

  // Once a resolved flag is gone from the list, re-home focus.
  useEffect(() => {
    // Time-boxed: if the list never changed at all this effect doesn't
    // run, so records have to go stale on their own — otherwise some
    // later, unrelated change (a flag raised from NodeDetail, a
    // collaborator's resolve) would fire one and yank focus out of
    // whatever the author had moved on to.
    const now = Date.now();
    pendingFocus.current = pendingFocus.current.filter((p) => now - p.at <= RECENT_RESOLVE_MS);
    // Take the first record whose row has actually gone. The others
    // wait for the refetch that removes theirs.
    const at = pendingFocus.current.findIndex((p) => !flagIds.includes(p.resolvedId));
    if (at === -1) return;
    const [pending] = pendingFocus.current.splice(at, 1);
    if (!mayTakeFocus()) return;
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
    if (!mayTakeFocus()) return;
    resolveButtons.current.get(id)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvingKey]);

  /**
   * `hadFocus` is read at click time, not inferred later. Safari (and
   * Firefox with Full Keyboard Access off) leaves `activeElement` on
   * <body> after a mouse click on a button, which is the same place a
   * disable-blur leaves it — so without this, a mouse user's click
   * would look exactly like a keyboard user's and we'd move focus onto
   * a Resolve button they never touched. Their next Space, pressed to
   * scroll the page, would resolve a flag they never read.
   */
  async function resolve(flagId: string, hadFocus: boolean) {
    setResolving((prev) => new Set(prev).add(flagId));
    setError(null);
    try {
      await resolveNodeFlag(projectId, flagId);
      const at = flagIds.indexOf(flagId);
      resolveCredits.current.push(Date.now());
      if (hadFocus) {
        pendingFocus.current.push({
          resolvedId: flagId,
          // Prefer the flag below; at the end of the list, step back up.
          nextId: flagIds[at + 1] ?? flagIds[at - 1] ?? null,
          at: Date.now(),
        });
      }
      onFlagsChanged();
    } catch (e) {
      if (hadFocus) refocusOnFailure.current = flagId;
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
  const errorAlert = error ? (
    <div className="alert alert-error" role="alert" data-testid="flagged-panel-error">
      {error}
    </div>
  ) : null;
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
  // stays, so "you resolved the last one" still gets said, and so does
  // a failure. A collaborator can clear the last flag while the
  // author's own Resolve for it is still in flight; that comes back
  // 404 at the same moment the list empties, and dropping the alert
  // with the panel would leave the click with no outcome at all.
  if (entries.length === 0)
    return (
      <>
        {statusRegion}
        {errorAlert}
      </>
    );

  return (
    <>
      {statusRegion}
      <section
        ref={panelRef}
        className="flagged-panel"
        data-testid="flagged-panel"
        aria-label="Flagged passages"
      >
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
            {errorAlert}
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
                          onClick={(e) =>
                            void resolve(f.id, document.activeElement === e.currentTarget)
                          }
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
