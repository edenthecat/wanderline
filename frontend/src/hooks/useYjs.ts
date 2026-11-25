// Yjs document connected to the backend collab
// WebSocket. Returns the shared Y.Doc + awareness for the given
// project, plus a connection state for UI ("connecting" /
// "connected" / "disconnected"). Auto-reconnects on disconnect.
//
// The hook is single-instance per projectId — multiple components
// (StoryTab, GraphTab's detail rail, AudioTab) inside the same
// project page share one Doc by re-using a module-level registry.
// That matters because Yjs's coalesce-and-broadcast loop relies on
// every observer being on the same Doc; constructing N Docs for N
// hooks would defeat the merge semantics.

import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';

interface DocEntry {
  doc: Y.Doc;
  provider: WebsocketProvider;
  refCount: number;
  /** Closed by the idle-tab handler rather than by the network. */
  idleDisconnected: boolean;
}

const registry = new Map<string, DocEntry>();

/**
 * How long a tab may sit hidden before we drop its collab socket.
 *
 * This exists for hosting cost, not correctness. Cloud Run bills for
 * the whole duration of a request, and a WebSocket is one very long
 * request — so a single forgotten editor tab keeps a backend instance
 * billable indefinitely, reconnecting through the 900s service
 * timeout, even with min-instances=0. Dropping the socket lets the
 * service actually scale to zero.
 *
 * 60s rather than something instant: switching tabs for a few seconds
 * is normal, and a reconnect is not free (see `resumeFromIdle` — it
 * rebuilds the doc). The delay also guarantees any update typed just
 * before hiding has long since been flushed to the server, since
 * y-websocket sends on change rather than on an interval.
 */
const IDLE_DISCONNECT_MS = 60_000;

/**
 * The close code the server sends when it tears a collab room down.
 *
 * Wider than it sounds: `invalidateRoom` runs for an ink re-upload, a
 * snapshot restore and a rename, but ALSO for every structural story
 * edit — adding, deleting, retargeting or swapping a choice, and
 * setting a divert (projects-story.ts). That is the ordinary
 * graph-editing loop, not a rare event. Pure text edits deliberately do
 * not invalidate.
 *
 * So rebuilding here is not free: each structural edit by any
 * collaborator drops every peer's undo stack and discards up to the
 * shadow saver's debounce window (2s) of un-persisted typing. The
 * server already abandons that window — invalidateRoom cancels the
 * pending save rather than flushing it — so pre-fix the only thing
 * preserving it was the stale re-push this exists to stop. Losing two
 * seconds of typing beats resurrecting a replaced passage, but the
 * right long-term fix is server-side: mutate the room's Y.Doc in place
 * for routine structural edits instead of tearing it down.
 *
 * See `invalidateRoom` in backend/src/services/collab-server.ts.
 */
const ROOM_INVALIDATED = 1012;

/**
 * Consumers to notify when a project's doc is swapped out from under
 * them. Keyed by projectId; each `useYjs` adds one while mounted.
 */
const listeners = new Map<string, Set<(entry: DocEntry | null) => void>>();

function notify(projectId: string, entry: DocEntry | null): void {
  listeners.get(projectId)?.forEach((fn) => fn(entry));
}

export type CollabStatus = 'connecting' | 'connected' | 'disconnected';

export interface UseYjsResult {
  /** Null on the first render (before the acquire effect runs). */
  doc: Y.Doc | null;
  /** Null on the first render (before the acquire effect runs). */
  awareness: Awareness | null;
  status: CollabStatus;
}

function makeBaseUrl(): string {
  // Use the same origin the browser is on, swap http(s) → ws(s).
  // y-websocket's WebsocketProvider appends "/" + roomname to this
  // base when it constructs the connection URL, so the projectId
  // does NOT belong here — passing it in as the `room` arg builds
  // the right `/ws/projects/<id>` path.
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/projects`;
}

function createEntry(projectId: string): DocEntry {
  const doc = new Y.Doc();
  // y-websocket auto-reconnects with backoff by default.
  const provider = new WebsocketProvider(makeBaseUrl(), projectId, doc, {
    // Pass the WebSocket constructor explicitly so the provider
    // doesn't try the global one before tree-shaking kicks in.
    WebSocketPolyfill: WebSocket,
  });
  const entry: DocEntry = { doc, provider, refCount: 0, idleDisconnected: false };
  // A plain reconnect must keep this doc — that is how an offline edit
  // survives a flaky network. But when the SERVER invalidated the room,
  // reconnecting with this doc is exactly wrong: y-websocket sends sync
  // step 1 from it on every open, pushing state the server has already
  // replaced back up into the freshly-hydrated doc. Yjs then merges the
  // two histories, and because a concurrent write to the same Y.Map key
  // is settled by comparing client ids — not by which edit is newer —
  // the stale side wins about half the time (measured at 49.8% over
  // 2000 trials against the real seed shape). The shadow saver
  // materializes the merged result straight over story_graph.nodes, so
  // an author who re-uploaded their ink watched the previous version's
  // choices and diverts come back, intermittently, while their browser
  // sat open on the project.
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (event?.code !== ROOM_INVALIDATED) return;
    // Deferred: we are inside the provider's own close handler, and
    // destroy() unwinds the object that is mid-dispatch.
    queueMicrotask(() => rebuild(projectId, entry));
  });
  return entry;
}

/**
 * Replace a project's doc with a fresh one, keeping the consumer count.
 *
 * Both notifications happen in one microtask, so React 18 batches them
 * into a single render that goes straight from the old doc to the new
 * one. Nothing ever renders against the destroyed doc, but do NOT rely
 * on observing the intermediate `null` — nothing downstream sees it.
 * `useYjsSeedReady` used to depend on exactly that and silently
 * stranded every collaborative input on its REST fallback.
 */
function rebuild(projectId: string, stale: DocEntry): void {
  const current = registry.get(projectId);
  // A newer entry already replaced this one, or everyone unmounted.
  if (!current || current !== stale) return;
  const refCount = current.refCount;
  registry.delete(projectId);
  notify(projectId, null);
  try {
    current.provider.destroy();
  } catch {}
  current.doc.destroy();
  if (refCount <= 0) return;
  const fresh = createEntry(projectId);
  fresh.refCount = refCount;
  registry.set(projectId, fresh);
  notify(projectId, fresh);
}

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityBound = false;

/** Drop every live socket. The docs stay; only the transport closes. */
function suspendForIdle(): void {
  idleTimer = null;
  for (const entry of registry.values()) {
    if (entry.idleDisconnected) continue;
    entry.idleDisconnected = true;
    // disconnect(), not destroy(): this clears y-websocket's
    // shouldConnect flag, so its backoff loop stops trying to reopen.
    // destroy() would also tear down the doc under a mounted consumer.
    try {
      entry.provider.disconnect();
    } catch {}
  }
}

/**
 * Come back from an idle disconnect with a FRESH doc, not a reconnect.
 *
 * Reconnecting the existing doc would be the cheap option, and it is
 * what a flaky-network reconnect correctly does. It is wrong here. The
 * `connection-close` guard above can only notice ROOM_INVALIDATED while
 * we are connected — if the server replaced the room while this tab sat
 * hidden, we never saw the close code, and y-websocket opens by sending
 * sync step 1 from our stale doc. That is precisely the merge that
 * resurrects replaced story state (see createEntry's note: the stale
 * side wins about half the time).
 *
 * Deliberately disconnecting makes that window routine instead of rare,
 * so resuming rebuilds. The cost is the undo stack, which a structural
 * edit by any collaborator already discards; the benefit is that a tab
 * left open overnight cannot push yesterday's graph back over today's.
 */
function resumeFromIdle(): void {
  // Snapshot: rebuild() mutates the registry while we iterate it.
  for (const [projectId, entry] of [...registry.entries()]) {
    if (!entry.idleDisconnected) continue;
    rebuild(projectId, entry);
  }
}

function cancelIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/**
 * Resume, but only for a tab that is actually on screen.
 *
 * The visibility guard is the whole point of the suspension: `focus`
 * and `online` can both fire while the tab is still hidden — a
 * background window can take focus, and the network can come back at
 * any time — and resuming there would re-open a billable socket for a
 * tab nobody is looking at.
 *
 * Note this is a no-op unless something is flagged idleDisconnected, so
 * the common case (network blip on a visible tab) still goes through
 * y-websocket's own backoff rather than a rebuild.
 */
function resumeIfVisible(): void {
  if (document.hidden) return;
  cancelIdleTimer();
  resumeFromIdle();
}

function handleVisibility(): void {
  if (document.hidden) {
    cancelIdleTimer();
    idleTimer = setTimeout(suspendForIdle, IDLE_DISCONNECT_MS);
    return;
  }
  resumeIfVisible();
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', handleVisibility);
  // `focus` and `online` are belt-and-braces. While suspended we have
  // cleared y-websocket's shouldConnect flag, so its backoff loop is
  // not going to re-dial for us — visibilitychange is otherwise the
  // only wake-up path, and a tab that comes back without firing it
  // would sit disconnected indefinitely.
  window.addEventListener('focus', resumeIfVisible);
  window.addEventListener('online', resumeIfVisible);
  visibilityBound = true;
}

function unbindVisibility(): void {
  if (!visibilityBound) return;
  document.removeEventListener('visibilitychange', handleVisibility);
  window.removeEventListener('focus', resumeIfVisible);
  window.removeEventListener('online', resumeIfVisible);
  visibilityBound = false;
  cancelIdleTimer();
}

function acquire(projectId: string): DocEntry {
  const existing = registry.get(projectId);
  if (existing) {
    existing.refCount++;
    return existing;
  }
  const entry = createEntry(projectId);
  entry.refCount = 1;
  registry.set(projectId, entry);
  bindVisibility();
  return entry;
}

function release(projectId: string): void {
  const entry = registry.get(projectId);
  // A rebuild may have swapped the entry since this consumer acquired;
  // the count lives on whatever is registered now, which is what the
  // rebuild carried over.
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount > 0) return;
  // Last consumer left — tear down the websocket + doc.
  try {
    entry.provider.destroy();
  } catch {}
  entry.doc.destroy();
  registry.delete(projectId);
  if (registry.size === 0) unbindVisibility();
}

export function useYjs(projectId: string): UseYjsResult {
  // Acquire + release are paired ONLY inside this effect. An earlier
  // version did the acquire in `useState`'s lazy initializer to make
  // doc available on the first paint, but (a) useState's init runs
  // once per mount while React StrictMode's dev double-invoke runs
  // the effect cleanup an extra time — driving refCount to 0 and
  // destroying the Doc behind a still-mounted consumer — and (b) the
  // init won't re-run when the projectId prop changes, so a route
  // that re-uses the component for a different project would keep
  // returning the OLD project's doc. Moving acquire into the effect
  // means the first paint sees `doc: null` (every consumer handles
  // null), the cleanup is paired 1-to-1 with the acquire, AND a
  // projectId change re-runs the effect, releasing the old project
  // and acquiring the new one.
  const [entry, setEntry] = useState<DocEntry | null>(null);
  const [status, setStatus] = useState<CollabStatus>('connecting');

  useEffect(() => {
    let active = acquire(projectId);
    setEntry(active);
    setStatus(active.provider.wsconnected ? 'connected' : 'connecting');

    const onStatus = (event: { status: CollabStatus }) => setStatus(event.status);
    active.provider.on('status', onStatus);

    // The server can replace this doc mid-session (see `rebuild`). Move
    // the status listener onto whatever doc is current, or the UI keeps
    // reporting the connection state of a destroyed provider.
    const onSwap = (next: DocEntry | null) => {
      active.provider.off('status', onStatus);
      setEntry(next);
      if (!next) {
        setStatus('connecting');
        return;
      }
      active = next;
      next.provider.on('status', onStatus);
      setStatus(next.provider.wsconnected ? 'connected' : 'connecting');
    };
    let subs = listeners.get(projectId);
    if (!subs) {
      subs = new Set();
      listeners.set(projectId, subs);
    }
    subs.add(onSwap);

    return () => {
      subs.delete(onSwap);
      if (subs.size === 0) listeners.delete(projectId);
      active.provider.off('status', onStatus);
      release(projectId);
      // Drop the local reference so a projectId change can't render
      // stale state from the previous project before the new effect
      // re-acquires.
      setEntry((prev) => (prev === active ? null : prev));
    };
  }, [projectId]);

  return {
    doc: entry?.doc ?? null,
    awareness: entry?.provider.awareness ?? null,
    status,
  };
}

// For tests.
export function _resetYjsRegistry(): void {
  listeners.clear();
  for (const entry of registry.values()) {
    try {
      entry.provider.destroy();
    } catch {}
    entry.doc.destroy();
  }
  registry.clear();
  // Also drops the pending idle timer, so a test that hid the tab
  // can't fire suspendForIdle into the next test's registry.
  unbindVisibility();
}
