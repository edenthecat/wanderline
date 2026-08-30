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
}

const registry = new Map<string, DocEntry>();

/**
 * The close code the server sends when it tears a collab room down
 * after a destructive write — an ink re-upload, a snapshot restore, a
 * rename. See `invalidateRoom` in backend/src/services/collab-server.ts.
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
  const entry: DocEntry = { doc, provider, refCount: 0 };
  // A plain reconnect must keep this doc — that is how an offline edit
  // survives a flaky network. But when the SERVER invalidated the room,
  // reconnecting with this doc is exactly wrong: y-websocket sends sync
  // step 1 from it on every open, pushing state the server has already
  // replaced back up into the freshly-hydrated doc. Yjs then merges the
  // two histories, and because a concurrent write to the same Y.Map key
  // is settled by comparing client ids — not by which edit is newer —
  // the stale side wins roughly two times in three. The shadow saver
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
 * Consumers see `null` first so nothing renders against a destroyed
 * doc, then the replacement, which hydrates from the server's current
 * row instead of arguing with it.
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

function acquire(projectId: string): DocEntry {
  const existing = registry.get(projectId);
  if (existing) {
    existing.refCount++;
    return existing;
  }
  const entry = createEntry(projectId);
  entry.refCount = 1;
  registry.set(projectId, entry);
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
}
