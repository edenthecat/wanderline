// Heavy-test ladder for the phase 4 shadow saver. The
// scary failure mode is silent data loss — if the saver misses an
// update or writes a stale snapshot, the next Cloud Run cold start
// hydrates from a clobbered row. These cases pin the obvious
// failure paths: debounce coalesces bursts, the SQL UPDATE merges
// rather than replaces, the seed transaction doesn't trigger a
// write (because the DB row was already correct), and `flush`
// forces a synchronous write.

import { jest } from '@jest/globals';
import * as Y from 'yjs';
import { CollabShadowSaver } from '../collab-shadow-saver.js';
import { seedYDocFromStoryGraph } from '../yjs-story.js';
import type { StoryGraph } from '../../types.js';

interface QueryCall {
  text: string;
  params: unknown[];
}

function mockPool() {
  const calls: QueryCall[] = [];
  return {
    calls,
    pool: {
      query: jest.fn(async (text: string, params: unknown[]) => {
        calls.push({ text, params });
        return { rows: [] };
      }),
    },
  };
}

function tickTimers(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drive a non-seed mutation through the nodes map so the saver's
 * observeDeep fires. The saver intentionally ONLY watches the nodes
 * map (phase 6 added an unrelated `__signals__` map on the same Doc
 * that must not trigger persistence), so the tests can't use a
 * synthetic top-level Y.Text — they have to mutate something the
 * saver actually observes.
 */
function mutateNode(doc: Y.Doc, nodeId = 'start', append = 'x'): void {
  const nodes = doc.getMap<Y.Map<unknown>>('nodes');
  const node = nodes.get(nodeId);
  if (!node) throw new Error(`mutateNode: ${nodeId} not seeded`);
  const content = node.get('content') as Y.Array<Y.Map<unknown>>;
  const item = content.get(0) as Y.Map<unknown>;
  const text = item.get('text') as Y.Text;
  text.insert(text.length, append);
}

function seedSimple(doc: Y.Doc, projectId = 'p'): void {
  seedYDocFromStoryGraph(doc, {
    id: projectId,
    title: 't',
    startNode: 'start',
    validation: { valid: true, errors: [], warnings: [] },
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        parent: null,
        content: [{ text: 'hi', tags: [] }],
        choices: [],
        divert: null,
        tags: [],
        lineNumber: 1,
      },
    },
  });
}

describe('CollabShadowSaver', () => {
  it('debounces a burst of edits into a single write', async () => {
    const { pool, calls } = mockPool();
    const doc = new Y.Doc();
    seedSimple(doc, 'p1');
    const saver = new CollabShadowSaver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      'p1',
      doc,
      { debounceMs: 50 },
    );

    mutateNode(doc, 'start', 'a');
    mutateNode(doc, 'start', 'b');
    mutateNode(doc, 'start', 'c');
    mutateNode(doc, 'start', 'd');

    // Bursts of 4 ops should still produce exactly one DB write.
    await tickTimers(120);
    expect(calls).toHaveLength(1);
    await saver.destroy();
  });

  it('ignores updates to non-nodes maps (e.g. the __signals__ live channel)', async () => {
    // Phase 6's live-signal channel writes to a separate top-level
    // map. The saver must not treat those writes as story content
    // changes — otherwise every audio assignment / metadata save by
    // any peer would trigger a redundant story_graph UPDATE.
    const { pool, calls } = mockPool();
    const doc = new Y.Doc();
    seedSimple(doc, 'p-sig');
    const saver = new CollabShadowSaver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      'p-sig',
      doc,
      { debounceMs: 30 },
    );
    doc.getMap<number>('__signals__').set('audio-assignments', Date.now());
    doc.getText('demo:projectName').insert(0, 'unrelated-text');
    await tickTimers(80);
    expect(calls).toHaveLength(0);
    await saver.destroy();
  });

  it('does NOT write for the seed transaction (origin=seed)', async () => {
    const { pool, calls } = mockPool();
    const doc = new Y.Doc();
    const saver = new CollabShadowSaver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      'p2',
      doc,
      { debounceMs: 30 },
    );
    const graph: StoryGraph = {
      id: 'p2',
      title: 'Seed Test',
      startNode: 'start',
      validation: { valid: true, errors: [], warnings: [] },
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          parent: null,
          content: [{ text: 'hi', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 1,
        },
      },
    };
    seedYDocFromStoryGraph(doc, graph);

    await tickTimers(100);
    expect(calls).toHaveLength(0);
    await saver.destroy();
  });

  it('persists the materialized nodes as a jsonb merge (preserves other story_graph keys)', async () => {
    const { pool, calls } = mockPool();
    const doc = new Y.Doc();
    const saver = new CollabShadowSaver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      'p3',
      doc,
      { debounceMs: 30 },
    );

    // Seed first (skipped by the saver because origin='seed'), then
    // mutate so the saver fires once.
    seedYDocFromStoryGraph(doc, {
      id: 'p3',
      title: 't',
      startNode: 'start',
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          parent: null,
          content: [{ text: 'hi', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 1,
        },
      },
      validation: { valid: true, errors: [], warnings: [] },
    });
    const nodesMap = doc.getMap('nodes') as unknown as Y.Map<Y.Map<unknown>>;
    const content = (nodesMap.get('start') as Y.Map<unknown>).get('content') as Y.Array<
      Y.Map<unknown>
    >;
    const first = content.get(0) as Y.Map<unknown>;
    (first.get('text') as Y.Text).insert((first.get('text') as Y.Text).length, '!');

    await tickTimers(100);
    expect(calls).toHaveLength(1);
    const sql = calls[0].text;
    // Critical: the SQL must MERGE (||) onto the existing
    // story_graph, not REPLACE it. Otherwise title/validation/
    // source disappear on every save.
    expect(sql).toMatch(/jsonb_build_object\('nodes', \$2/);
    expect(sql).toMatch(/COALESCE\(story_graph,\s*'\{\}'::jsonb\)\s*\|\|/);
    expect(calls[0].params[0]).toBe('p3');
    const payload = JSON.parse(calls[0].params[1] as string) as Record<string, unknown>;
    expect(payload.start).toBeDefined();
    await saver.destroy();
  });

  it('flush() forces a synchronous write of any pending edits', async () => {
    const { pool, calls } = mockPool();
    const doc = new Y.Doc();
    seedSimple(doc, 'p4');
    const saver = new CollabShadowSaver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      'p4',
      doc,
      { debounceMs: 5_000 }, // long enough that we'd never naturally fire
    );
    mutateNode(doc, 'start', 'flush-me');
    await saver.flush();
    expect(calls).toHaveLength(1);
    await saver.destroy();
  });

  it('destroy() detaches the observer and cancels pending timers', async () => {
    const { pool, calls } = mockPool();
    const doc = new Y.Doc();
    seedSimple(doc, 'p5');
    const saver = new CollabShadowSaver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      'p5',
      doc,
      { debounceMs: 30 },
    );
    mutateNode(doc, 'start', 'x');
    await saver.destroy();
    await tickTimers(80);
    // No write should have fired because the timer was cancelled
    // before the debounce window elapsed.
    expect(calls).toHaveLength(0);
    // A further edit shouldn't re-fire either.
    mutateNode(doc, 'start', 'y');
    await tickTimers(80);
    expect(calls).toHaveLength(0);
  });

  it('flush() rejects when the underlying UPDATE fails (so snapshot capture can detect a stale read)', async () => {
    // Regression: previously persist() caught and swallowed all
    // DB errors, so a transient write failure in the snapshot
    // capture's flushPendingShadowSave path silently produced a
    // snapshot missing recent edits. flush() must propagate the
    // error so the caller knows the row may be stale.
    const dbError = new Error('connection refused');
    const pool = {
      query: jest.fn(async () => {
        throw dbError;
      }),
    };
    const doc = new Y.Doc();
    seedSimple(doc, 'p-fail');
    const saver = new CollabShadowSaver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      'p-fail',
      doc,
    );
    mutateNode(doc, 'start', '!');
    await expect(saver.flush()).rejects.toThrow('connection refused');
    await saver.destroy();
  });

  it('destroy() awaits an in-flight UPDATE so a stale write can never land after destroy returns', async () => {
    // The race that matters: snapshot restore writes the new row,
    // then calls invalidateRoom → shadowSaver.destroy(). If destroy()
    // is synchronous but there's a 500ms UPDATE in-flight, that
    // older UPDATE will land AFTER the restore and revert the row.
    // destroy must await the in-flight query.
    const calls: QueryCall[] = [];
    let resolveQuery: (() => void) | null = null;
    const pool = {
      query: jest.fn(
        (text: string, params: unknown[]) =>
          new Promise<{ rows: unknown[] }>((resolve) => {
            calls.push({ text, params });
            resolveQuery = () => resolve({ rows: [] });
          }),
      ),
    };
    const doc = new Y.Doc();
    seedSimple(doc, 'p6');
    const saver = new CollabShadowSaver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      'p6',
      doc,
      { debounceMs: 10 },
    );
    mutateNode(doc, 'start', '!');
    // Let the debounce fire and persist() enter pool.query.
    await tickTimers(40);
    expect(calls).toHaveLength(1);
    expect(resolveQuery).not.toBeNull();
    // Start destroy in parallel; it should NOT resolve until we
    // release the in-flight query.
    let destroyed = false;
    const destroyPromise = saver.destroy().then(() => {
      destroyed = true;
    });
    await tickTimers(30);
    expect(destroyed).toBe(false);
    resolveQuery!();
    await destroyPromise;
    expect(destroyed).toBe(true);
  });
});
