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
  // Which flags we watched resolve, and when. Keyed by id rather than
  // counted, because one refetch can reflect two resolves at once —
  // spending a fixed number of credits per change would strand the
  // extras, and a stranded credit gets spent by the next unrelated
  // change, up to and including the empty list a failed fetch reports.
  // A credit is redeemed when its own row is gone, so batching is just
  // two redemptions in one pass.
  const resolveCredits = useRef(new Map<string, number>());

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
    // that lands minutes later. And they have to be redeemable on a
    // change that leaves the count flat — resolving one flag while a
    // collaborator raises another moves neither the total nor the
    // summary string, which is why `flagIdKey` is in the deps.
    const now = Date.now();
    let landed = 0;
    for (const [id, at] of resolveCredits.current) {
      if (now - at > RECENT_RESOLVE_MS) {
        resolveCredits.current.delete(id);
      } else if (!flagIds.includes(id)) {
        resolveCredits.current.delete(id);
        landed += 1;
      }
    }

    // The state on arrival isn't news; only announce changes to it.
    if (lastTotal.current === null) {
      lastTotal.current = total;
      return;
    }
    const prev = lastTotal.current;
    if (prev === total) {
      // Staying silent when the count holds steady across a resolve
      // reads as "your click did nothing", so say both halves.
      if (landed > 0) setAnnouncement(`Flag resolved. ${openSummary}`);
      return;
    }
    lastTotal.current = total;
    const ours = landed > 0;
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
    // `flagIdKey` is the stable string form of `flagIds`; depending on
    // the array itself would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const live = pendingFocus.current.filter((p) => now - p.at <= RECENT_RESOLVE_MS);
    // Drain *every* record whose row has gone, not just the first. One
    // refetch can reflect two resolves, and a record left queued is
    // permanently satisfied — it would fire on the next unrelated
    // change and pull focus off whatever the author had moved to.
    const satisfied = live.filter((p) => !flagIds.includes(p.resolvedId));
    pendingFocus.current = live.filter((p) => flagIds.includes(p.resolvedId));
    if (satisfied.length === 0) return;
    // The most recent removal is the one the author is standing on.
    const pending = satisfied[satisfied.length - 1];
    if (!mayTakeFocus()) return;
    const next = pending.nextId ? resolveButtons.current.get(pending.nextId) : undefined;
    // Skip a candidate that cannot take focus. A Resolve button whose
    // own request is still in flight is disabled ("Saving…"), and
    // .focus() on a disabled element is a silent no-op — so committing
    // to `next` without checking left focus on <body>, which is exactly
    // the bug this effect exists to prevent. Reachable whenever two
    // resolves overlap, which the queue and the `resolving` Set are
    // built to support: resolve one flag on a slow connection, then
    // resolve the one above it.
    const focusable = (el: HTMLElement | null | undefined): HTMLElement | undefined =>
      el && !(el as HTMLButtonElement).disabled ? el : undefined;
    (focusable(next) ?? focusable(summaryRef.current) ?? statusRef.current)?.focus();
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
   * `byKeyboard` decides whether focus is ours to move afterwards, and
   * it is read from the event rather than inferred from where focus
   * happens to sit. `activeElement` can't answer this: Safari leaves it
   * on <body> after a mouse click (the same place a disable-blur
   * leaves it), while Chromium focuses the button on mousedown — so
   * either browser would misread half its users. A click synthesised
   * from Enter or Space carries `detail === 0`; a pointer click
   * carries the click count. Only the former asked for focus.
   */
  async function resolve(flagId: string, byKeyboard: boolean) {
    setResolving((prev) => new Set(prev).add(flagId));
    setError(null);
    try {
      await resolveNodeFlag(projectId, flagId);
      const at = flagIds.indexOf(flagId);
      resolveCredits.current.set(flagId, Date.now());
      if (byKeyboard) {
        pendingFocus.current.push({
          resolvedId: flagId,
          // Prefer the flag below; at the end of the list, step back up.
          nextId: flagIds[at + 1] ?? flagIds[at - 1] ?? null,
          at: Date.now(),
        });
      }
      onFlagsChanged();
    } catch (e) {
      if (byKeyboard) refocusOnFailure.current = flagId;
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
                          onClick={(e) => void resolve(f.id, e.detail === 0)}
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
