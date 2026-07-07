// server-side shadow saver for the collaborative
// Y.Doc.
//
// Every Y.Doc update that touches the nodes map — whether produced
// by a connected editor or by the seed pass on first connect —
// kicks a debounced save. When the debounce window elapses, the
// saver materializes the Y.Doc's current node state to JSON and
// UPDATEs project_stories.story_graph in place. That keeps every
// non-collab consumer (preview, build, validation) reading fresh
// data without any of them needing to know about Y.Doc, AND it
// makes the Y.Doc's in-memory state recoverable: a Cloud Run cold
// start drops the in-memory Doc, but the next client reconnect
// re-hydrates it from the persisted row via collab-server's
// existing seed path.
//
// We attach via `nodesMap.observeDeep` rather than `doc.on('update')`
// so unrelated maps on the same Y.Doc (the `__signals__` live-
// invalidation channel from phase 6) don't trigger redundant
// story_graph writes.
//
// Important: the saver only writes the `nodes` map (the part the
// Y.Doc owns). Other story_graph fields (id, title, startNode,
// validation, source) come from the existing row — we read them
// alongside and write the merged object back. If we wrote ONLY
// the nodes map we'd silently destroy the title/validation each
// time.

import * as Y from 'yjs';
import type { Pool } from 'pg';
import { materializeNodesFromYDoc } from './yjs-story.js';
import { logger } from '../logger.js';

const DEFAULT_DEBOUNCE_MS = 2000;
const NODES_KEY = 'nodes';

export interface ShadowSaverOptions {
  /** Delay between the last edit and the persisted write. */
  debounceMs?: number;
  /** Test hook so unit tests can use a fake clock. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Wires a Y.Doc's nodes map to a debounced SQL UPDATE. Construct
 * once per room. Call `flush` to force-write any pending edits
 * synchronously. Call `destroy` (which is async) to detach the
 * observer, cancel pending timers, and await any in-flight DB
 * query so a subsequent caller-driven write can't race with a
 * trailing stale UPDATE.
 */
export class CollabShadowSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private detached = false;
  private readonly observer: (
    events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
    transaction: Y.Transaction,
  ) => void;
  /**
   * Promise resolved when any currently-running persist() finishes.
   * destroy() awaits this so the caller can rely on no stale UPDATE
   * landing after destroy() returns — important when invalidateRoom
   * is paired with a fresh row write that the saver mustn't overwrite.
   * This one always resolves (never rejects) — see `inFlightRaw`
   * for the underlying persist() promise that callers wanting
   * error visibility can await.
   */
  private inFlight: Promise<void> | null = null;
  /**
   * The raw persist() promise — rejects if the underlying UPDATE
   * fails. Subscribed-to only by `flush()` (which propagates
   * errors); other callers should await `inFlight` so an
   * unobserved rejection can't crash the process.
   */
  private inFlightRaw: Promise<void> | null = null;
  private readonly nodesMap: Y.Map<Y.Map<unknown>>;

  constructor(
    private readonly pool: Pool,
    private readonly projectId: string,
    private readonly doc: Y.Doc,
    private readonly options: ShadowSaverOptions = {},
  ) {
    this.nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
    this.observer = (_events, transaction) => {
      // Don't write for the seed transaction we just did from the
      // DB row — the row is already correct. Tag set by
      // seedYDocFromStoryGraph.
      if (transaction.origin === 'seed') return;
      this.schedule();
    };
    this.nodesMap.observeDeep(this.observer);
  }

  private schedule() {
    const debounce = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = this.options.clearTimeoutFn ?? clearTimeout;
    if (this.timer) clearTimeoutFn(this.timer);
    this.timer = setTimeoutFn(() => {
      this.timer = null;
      void this.runPersist();
    }, debounce);
  }

  /**
   * Force-write immediately. Resolves once the UPDATE completes,
   * REJECTS if the write fails. Callers that depend on the row
   * being fresh (snapshot capture, anyone reading project_stories
   * authoritatively) MUST be able to detect a failed flush — a
   * silent error would let them proceed to read a stale row while
   * thinking they had the latest Y.Doc state.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      const clearTimeoutFn = this.options.clearTimeoutFn ?? clearTimeout;
      clearTimeoutFn(this.timer);
      this.timer = null;
    }
    await this.runPersist(true);
  }

  private runPersist(rethrow = false): Promise<void> {
    // Coalesce overlapping calls so destroy()/flush() can both await
    // a single shared promise instead of racing two writes. Pass
    // through the rethrow flag so a flush() caller still surfaces
    // errors even if it joined an in-flight persist() that was
    // originally scheduled by the debounce (best-effort) path.
    //
    // We store the persist() promise pre-catch as `inFlightRaw` so
    // both rethrow=true and rethrow=false callers can subscribe to
    // the same write, AND we also chain a `.catch(noop)` into
    // `inFlight` so node's unhandled-rejection tracker doesn't see
    // the raw rejection if nobody subscribed in time.
    if (this.inFlightRaw) {
      return rethrow ? this.inFlightRaw : this.inFlightRaw.catch(() => undefined);
    }
    const p = this.persist();
    this.inFlightRaw = p;
    this.inFlight = p
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
        this.inFlightRaw = null;
      });
    return rethrow ? p : this.inFlight;
  }

  private async persist(): Promise<void> {
    if (this.detached) return;
    const nodes = materializeNodesFromYDoc(this.doc);
    try {
      // Merge with the existing story_graph so title / validation /
      // source / startNode / id all survive. Single-statement
      // jsonb merge so concurrent writers can't race-trash each
      // other's nodes diff.
      await this.pool.query(
        `UPDATE project_stories
         SET story_graph = COALESCE(story_graph, '{}'::jsonb) || jsonb_build_object('nodes', $2::jsonb),
             updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $1`,
        [this.projectId, JSON.stringify(nodes)],
      );
      logger.debug(
        { projectId: this.projectId, nodeCount: Object.keys(nodes).length },
        'collab: shadow-saver wrote story_graph.nodes',
      );
    } catch (err) {
      // The debounce-driven path logs and swallows so a transient
      // DB blip doesn't crash the room — the next edit will retry.
      // The flush()-driven path re-throws (via runPersist's rethrow
      // flag) so a caller that NEEDS the write to land can detect
      // the failure.
      logger.error({ err, projectId: this.projectId }, 'collab: shadow-saver write failed');
      throw err;
    }
  }

  /**
   * Async: detach the observer, cancel pending timers, AND wait
   * for any in-flight DB write to settle. Callers that immediately
   * overwrite the row (snapshot restore, ink reupload) depend on
   * this await so a trailing stale UPDATE can't stomp the new row.
   */
  async destroy(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    const clearTimeoutFn = this.options.clearTimeoutFn ?? clearTimeout;
    if (this.timer) {
      clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.nodesMap.unobserveDeep(this.observer);
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // persist() catches its own errors; this catch is just a
        // belt-and-braces for finalizer rejection.
      }
    }
  }
}
