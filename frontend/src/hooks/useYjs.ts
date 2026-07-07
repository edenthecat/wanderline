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

function acquire(projectId: string): DocEntry {
  let entry = registry.get(projectId);
  if (entry) {
    entry.refCount++;
    return entry;
  }
  const doc = new Y.Doc();
  // y-websocket auto-reconnects with backoff by default.
  const provider = new WebsocketProvider(makeBaseUrl(), projectId, doc, {
    // Pass the WebSocket constructor explicitly so the provider
    // doesn't try the global one before tree-shaking kicks in.
    WebSocketPolyfill: WebSocket,
  });
  entry = { doc, provider, refCount: 1 };
  registry.set(projectId, entry);
  return entry;
}

function release(projectId: string): void {
  const entry = registry.get(projectId);
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
    const e = acquire(projectId);
    setEntry(e);
    setStatus(e.provider.wsconnected ? 'connected' : 'connecting');
    const onStatus = (event: { status: CollabStatus }) => setStatus(event.status);
    e.provider.on('status', onStatus);
    return () => {
      e.provider.off('status', onStatus);
      release(projectId);
      // Drop the local reference so a projectId change can't render
      // stale state from the previous project before the new effect
      // re-acquires.
      setEntry((prev) => (prev === e ? null : prev));
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
  for (const entry of registry.values()) {
    try {
      entry.provider.destroy();
    } catch {}
    entry.doc.destroy();
  }
  registry.clear();
}
