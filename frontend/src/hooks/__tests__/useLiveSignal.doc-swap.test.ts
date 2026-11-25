import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';

import { bumpLiveSignal, useLiveSignal } from '../useLiveSignal';

// Signals are transient: the shadow saver persists only the `nodes`
// map, so a room the server rehydrates comes back with an EMPTY
// __signals__ map. That matters whenever useYjs replaces the doc —
// room invalidation, or resuming an idle tab — because the tab was
// disconnected across the gap and cannot recover the bumps it missed.
//
// Without a forced catch-up the seed reads 0, the stale tick survives,
// no dependency changes, and AudioTab / useNodeEditor keep showing REST
// data fetched before the gap.

const KEY = 'audio-assignments';

describe('useLiveSignal across a doc swap', () => {
  it('does not force a tick for the first doc', () => {
    const doc = new Y.Doc();
    const { result } = renderHook(({ d }: { d: Y.Doc }) => useLiveSignal(d, KEY), {
      initialProps: { d: doc },
    });

    // Consumers fetch on mount already, and they skip tick 0, so the
    // first doc must not look like an invalidation.
    expect(result.current).toBe(0);
  });

  it('forces a catch-up tick when the doc is replaced with an empty one', () => {
    const first = new Y.Doc();
    const { result, rerender } = renderHook(({ d }: { d: Y.Doc }) => useLiveSignal(d, KEY), {
      initialProps: { d: first },
    });
    expect(result.current).toBe(0);

    // A rehydrated room: brand new doc, no signals in it at all.
    const replacement = new Y.Doc();
    act(() => rerender({ d: replacement }));

    // Non-zero so consumers don't skip it, which is what makes them
    // re-fetch the data they missed while disconnected.
    expect(result.current).not.toBe(0);
  });

  it('still forces a catch-up when the stale tick would otherwise survive', () => {
    const first = new Y.Doc();
    bumpLiveSignal(first, KEY);
    const { result, rerender } = renderHook(({ d }: { d: Y.Doc }) => useLiveSignal(d, KEY), {
      initialProps: { d: first },
    });
    const seeded = result.current;
    expect(seeded).not.toBe(0);

    const replacement = new Y.Doc();
    act(() => rerender({ d: replacement }));

    // The replacement has no signal, so the pre-fix code would have
    // left `seeded` in place and no consumer effect would re-run.
    expect(result.current).not.toBe(seeded);
    expect(result.current).not.toBe(0);
  });

  it('still reports an ordinary remote bump on the current doc', () => {
    const doc = new Y.Doc();
    const { result } = renderHook(({ d }: { d: Y.Doc }) => useLiveSignal(d, KEY), {
      initialProps: { d: doc },
    });

    // Simulate a peer's update arriving: apply it from a separate doc
    // so the transaction is not local, which is what the hook filters
    // on to avoid double-fetching on the originating tab.
    const peer = new Y.Doc();
    bumpLiveSignal(peer, KEY);
    act(() => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    });

    expect(result.current).not.toBe(0);
  });
});
