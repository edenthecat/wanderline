import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Cloud Run bills for the full duration of a request, and a WebSocket
// is one very long request, so an editor tab left open pins a backend
// instance even with min-instances=0. These pin the idle-tab handling
// that lets the service scale to zero: drop the socket after the tab
// has been hidden a while, and come back with a FRESH doc rather than
// reconnecting the stale one.
//
// That last part is the load-bearing bit. While we are disconnected we
// cannot observe the server's ROOM_INVALIDATED close code, so if the
// room was replaced while the tab sat hidden, reconnecting the old doc
// would send sync step 1 from it and resurrect replaced story state —
// the same corruption useYjs.invalidation.test.tsx covers.

const providers: FakeProvider[] = [];

class FakeProvider {
  awareness = { getStates: () => new Map(), setLocalState: () => {}, on: () => {}, off: () => {} };
  wsconnected = true;
  destroyed = false;
  disconnectCalls = 0;
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
  disconnect() {
    this.disconnectCalls++;
    this.wsconnected = false;
  }
  destroy() {
    this.destroyed = true;
  }
}

vi.mock('y-websocket', () => ({
  WebsocketProvider: FakeProvider,
}));

const { useYjs, _resetYjsRegistry } = await import('../useYjs');

const IDLE_MS = 60_000;

/**
 * Mount the hook, wait for the doc, THEN switch to fake timers.
 *
 * Order matters: testing-library's waitFor schedules its retries on
 * real timers, so installing fake timers before it runs deadlocks the
 * test instead of failing it.
 */
async function mountAndFreezeTime() {
  const rendered = renderHook(() => useYjs('p1'));
  await waitFor(() => expect(rendered.result.current.doc).not.toBeNull());
  vi.useFakeTimers();
  return rendered;
}

let hidden = false;

function setTabHidden(next: boolean): void {
  hidden = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  providers.length = 0;
  hidden = false;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
});

afterEach(() => {
  vi.useRealTimers();
  _resetYjsRegistry();
});

describe('useYjs idle-tab disconnect', () => {
  it('keeps the socket open while the tab is merely hidden briefly', async () => {
    await mountAndFreezeTime();
    const provider = providers[0];

    act(() => setTabHidden(true));
    act(() => void vi.advanceTimersByTime(IDLE_MS - 1));

    expect(provider.disconnectCalls).toBe(0);
  });

  it('drops the socket once the tab has been hidden past the grace period', async () => {
    await mountAndFreezeTime();
    const provider = providers[0];

    act(() => setTabHidden(true));
    act(() => void vi.advanceTimersByTime(IDLE_MS));

    expect(provider.disconnectCalls).toBe(1);
    // disconnect(), not destroy() — the doc must survive so a mounted
    // consumer keeps rendering against it while the tab is away.
    expect(provider.destroyed).toBe(false);
  });

  it('cancels the pending disconnect if the tab comes back in time', async () => {
    const { result } = await mountAndFreezeTime();
    const provider = providers[0];
    const doc = result.current.doc;

    act(() => setTabHidden(true));
    act(() => void vi.advanceTimersByTime(IDLE_MS - 1000));
    act(() => setTabHidden(false));
    act(() => void vi.advanceTimersByTime(IDLE_MS * 2));

    expect(provider.disconnectCalls).toBe(0);
    // No rebuild either: same doc, same provider, undo stack intact.
    expect(result.current.doc).toBe(doc);
    expect(providers).toHaveLength(1);
  });

  it('resumes with a FRESH doc rather than reconnecting the stale one', async () => {
    const { result } = await mountAndFreezeTime();
    const staleDoc = result.current.doc;
    const staleProvider = providers[0];

    act(() => setTabHidden(true));
    act(() => void vi.advanceTimersByTime(IDLE_MS));
    expect(staleProvider.disconnectCalls).toBe(1);

    act(() => setTabHidden(false));

    // A second provider was constructed, the first was torn down, and
    // the consumer is handed a different doc. If this ever regresses to
    // provider.connect() on the same doc, sync step 1 from the stale
    // doc can push replaced story state back to the server.
    expect(providers).toHaveLength(2);
    expect(staleProvider.destroyed).toBe(true);
    expect(result.current.doc).not.toBeNull();
    expect(result.current.doc).not.toBe(staleDoc);
  });

  it('does not disconnect again on a second hidden window while already idle', async () => {
    await mountAndFreezeTime();
    const provider = providers[0];

    act(() => setTabHidden(true));
    act(() => void vi.advanceTimersByTime(IDLE_MS));
    // Still hidden; another visibilitychange fires (some browsers emit
    // spurious ones). The already-idle entry must be left alone.
    act(() => setTabHidden(true));
    act(() => void vi.advanceTimersByTime(IDLE_MS));

    expect(provider.disconnectCalls).toBe(1);
  });
});
