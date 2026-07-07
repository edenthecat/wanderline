// a lightweight "data invalidated" fanout over the
// shared Y.Doc. Use cases like audio assignments and node metadata
// already have a robust REST persistence path; we don't want to
// migrate that data INTO the Y.Doc just to get live propagation.
// Instead, after a successful mutation each peer bumps a small
// counter on the doc and the others react by re-fetching from
// REST.
//
// The signal map keys live under the reserved `__signals__` slot so
// they can't collide with story content. Values are monotonic
// millisecond timestamps, both because they're cheaper than a
// version counter (no read-modify-write race) and because they
// make staleness debuggable.

import { useEffect, useState } from 'react';
import * as Y from 'yjs';

const SIGNALS_KEY = '__signals__';

function getSignalsMap(doc: Y.Doc): Y.Map<number> {
  return doc.getMap<number>(SIGNALS_KEY);
}

/** Push a fresh tick to all peers under the given key. */
export function bumpLiveSignal(doc: Y.Doc | null, key: string): void {
  if (!doc) return;
  const m = getSignalsMap(doc);
  // Use Date.now() so even a buggy single-client double-call still
  // produces two distinct ticks; peers don't care about the exact
  // value, only that it changes.
  m.set(key, Date.now());
}

/**
 * Subscribes to bumps under `key` and returns the latest tick value.
 * The numeric return is mostly an effect dependency: components
 * read it inside their own useEffect to know when to re-fetch.
 *
 * Returns 0 until the first observed bump (or 0 when doc is null).
 */
export function useLiveSignal(doc: Y.Doc | null, key: string): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!doc) return;
    const m = getSignalsMap(doc);
    const seed = (m.get(key) as number | undefined) ?? 0;
    if (seed !== 0) setTick(seed);
    // Y.YMapEvent's `transaction.local` is true when the mutation
    // originated in THIS Y.Doc instance (vs being applied from a
    // remote peer). The caller of bumpLiveSignal has already done
    // their own local refresh; skipping local writes here prevents
    // a redundant double-fetch on the originating tab.
    const onChange = (event: Y.YMapEvent<number>, transaction: Y.Transaction) => {
      if (!event.keysChanged.has(key)) return;
      if (transaction.local) return;
      const v = (m.get(key) as number | undefined) ?? 0;
      setTick(v);
    };
    m.observe(onChange);
    return () => m.unobserve(onChange);
  }, [doc, key]);
  return tick;
}
