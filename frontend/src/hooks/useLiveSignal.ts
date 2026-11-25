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

import { useEffect, useRef, useState } from 'react';
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
  const seenDocRef = useRef<Y.Doc | null>(null);
  useEffect(() => {
    if (!doc) return;
    const m = getSignalsMap(doc);
    // A REPLACEMENT doc (not the first one) means useYjs threw the
    // previous one away — room invalidation, or coming back from an
    // idle-tab suspension. Either way this tab was disconnected and may
    // have missed bumps, and it cannot recover them: the shadow saver
    // persists only the `nodes` map, so a room the server rehydrated
    // has an EMPTY signals map. The seed is then 0, the `seed !== 0`
    // branch below leaves the stale tick in place, no dependency
    // changes, and consumers keep rendering REST data fetched before
    // the gap (found in review — AudioTab and useNodeEditor both sat
    // on stale assignments after a peer changed them).
    //
    // So force one catch-up tick instead. Consumers skip tick 0 and
    // de-dupe on the previous value, so a fresh Date.now() is exactly
    // one refetch. The first doc deliberately does not trigger this:
    // consumers already fetch on mount.
    const replaced = seenDocRef.current !== null && seenDocRef.current !== doc;
    seenDocRef.current = doc;
    const seed = (m.get(key) as number | undefined) ?? 0;
    if (replaced) setTick(Date.now());
    else if (seed !== 0) setTick(seed);
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
