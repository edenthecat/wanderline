import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// An author reported the previous version of a passage coming back
// after they re-uploaded their ink: old choices restored, diverts
// pointing at passages that no longer exist, intermittently, while the
// editor sat open.
//
// The server is not at fault. A destructive write invalidates the
// collab room — the pending shadow save is cancelled, every socket is
// closed with 1012, and the next connection hydrates a fresh Y.Doc from
// the row. The client was: nothing looked at the close code, so
// y-websocket reconnected carrying the SAME local doc and sent sync
// step 1 from it, pushing replaced state back up. Yjs merges both
// histories and settles a concurrent Y.Map write by comparing client
// ids rather than recency, so the stale side wins much of the time —
// then the shadow saver writes the merged result over story_graph.nodes.
//
// The fix is that the client throws its doc away when the server says
// the room is gone. These tests pin that, and pin that an ORDINARY
// disconnect does not throw it away, because that is what lets an edit
// survive a flaky network.

const providers: FakeProvider[] = [];

class FakeProvider {
  awareness = { getStates: () => new Map(), setLocalState: () => {}, on: () => {}, off: () => {} };
  wsconnected = true;
  destroyed = false;
  handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  constructor(
    public url: string,
    public room: string,
    public doc: unknown,
  ) {
    providers.push(this);
  }
  on(event: string, fn: (...args: unknown[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
  }
  off(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.get(event)?.delete(fn);
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.forEach((fn) => fn(...args));
  }
  destroy() {
    this.destroyed = true;
  }
}

vi.mock('y-websocket', () => ({
  WebsocketProvider: FakeProvider,
}));

const { useYjs, _resetYjsRegistry } = await import('../useYjs');

beforeEach(() => {
  providers.length = 0;
});
afterEach(() => {
  _resetYjsRegistry();
});

describe('useYjs when the server invalidates the room', () => {
  it('throws the stale doc away and hands back a fresh one', async () => {
    const { result } = renderHook(() => useYjs('p1'));
    await waitFor(() => expect(result.current.doc).not.toBeNull());
    const staleDoc = result.current.doc;
    expect(providers).toHaveLength(1);

    // The server tore the room down after a destructive write.
    act(() => {
      providers[0].emit('connection-close', { code: 1012 });
    });

    await waitFor(() => expect(result.current.doc).not.toBe(staleDoc));
    expect(result.current.doc).not.toBeNull();
    // The doc that would have re-pushed replaced state is gone, and a
    // second provider is connecting in its place.
    expect(providers[0].destroyed).toBe(true);
    expect(providers).toHaveLength(2);
  });

  it('keeps the doc across an ordinary disconnect', async () => {
    const { result } = renderHook(() => useYjs('p1'));
    await waitFor(() => expect(result.current.doc).not.toBeNull());
    const doc = result.current.doc;

    // A dropped network, a server restart, a tab suspended — the doc
    // must survive these, or an edit made while offline is lost.
    act(() => {
      providers[0].emit('connection-close', { code: 1006 });
      providers[0].emit('connection-close', null);
    });

    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(result.current.doc).toBe(doc);
    expect(providers[0].destroyed).toBe(false);
    expect(providers).toHaveLength(1);
  });

  it('keeps every consumer of the project on the same replacement doc', async () => {
    // The registry is shared: StoryTab, GraphTab's rail and AudioTab
    // all hold the same doc. If a rebuild reached only one of them the
    // others would keep observing a destroyed doc.
    const a = renderHook(() => useYjs('p1'));
    const b = renderHook(() => useYjs('p1'));
    await waitFor(() => expect(a.result.current.doc).not.toBeNull());
    await waitFor(() => expect(b.result.current.doc).not.toBeNull());
    expect(a.result.current.doc).toBe(b.result.current.doc);

    act(() => {
      providers[0].emit('connection-close', { code: 1012 });
    });

    await waitFor(() => expect(a.result.current.doc).not.toBeNull());
    expect(a.result.current.doc).toBe(b.result.current.doc);
    expect(providers).toHaveLength(2);
  });
});
