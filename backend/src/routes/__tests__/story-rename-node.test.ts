import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { mountStoryRoutes } from '../projects-story.js';

// rename endpoint. Kept as a focused unit test — the endpoint
// runs a transaction (BEGIN → SELECT FOR UPDATE → UPDATE ×3 → COMMIT)
// so the mock returns a client with a scripted query sequence.

jest.mock('../../services/collab-server.js', () => ({
  invalidateRoom: jest.fn(async () => undefined),
}));

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof console }).log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as typeof console;
    next();
  });
  const router = express.Router();
  mountStoryRoutes(router, pool);
  app.use('/api/projects', router);
  return app;
}

interface ScriptedQuery {
  match: RegExp | string;
  rows?: unknown[];
}

function makePool(script: ScriptedQuery[]) {
  let i = 0;
  const clientQuery = jest.fn(async (sql: string) => {
    const step = script[i++];
    if (!step) throw new Error(`Unexpected query #${i}: ${sql.slice(0, 100)}`);
    const matched = step.match instanceof RegExp ? step.match.test(sql) : sql.includes(step.match);
    if (!matched) {
      throw new Error(
        `Query mismatch at step ${i}. Expected ${step.match}, got: ${sql.slice(0, 100)}`,
      );
    }
    return { rows: step.rows ?? [] } as { rows: unknown[] };
  });
  const release = jest.fn(() => undefined);
  const connect = jest.fn(async () => ({ query: clientQuery, release }));
  return {
    pool: { query: jest.fn(), connect } as unknown as Pool,
    clientQuery,
    release,
    consumedAll: () => i === script.length,
  };
}

// Build a StoryGraph shaped like what the parser produces.
function graph(startNode: string, nodes: Record<string, unknown>) {
  return {
    startNode,
    nodes,
    id: 'g1',
    title: 'T',
    validation: { valid: true, errors: [], warnings: [] },
  };
}

describe('PATCH /:id/story/node/rename', () => {
  const projectId = '00000000-0000-0000-0000-000000000001';

  it('renames a node, rewrites references, updates side tables, invalidates the cache', async () => {
    const storyGraph = graph('Home', {
      Home: { choices: [{ text: 'go', target: 'Kitchen' }], divert: null, parent: null },
      Kitchen: { choices: [], divert: 'Home', parent: null },
    });
    const { pool, consumedAll } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: /UPDATE project_stories/ },
      { match: /UPDATE node_audio_assignments\b/ },
      { match: /UPDATE node_metadata\b/ },
      { match: /UPDATE projects/ },
      { match: 'COMMIT' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'Kitchen', newId: 'Galley' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // startNode preserved (was Home, not Kitchen).
    expect(res.body.story_graph.startNode).toBe('Home');
    // Nodes map is re-keyed.
    expect(Object.keys(res.body.story_graph.nodes).sort()).toEqual(['Galley', 'Home']);
    // choice.target on Home rewrote from Kitchen → Galley.
    expect(res.body.story_graph.nodes.Home.choices[0].target).toBe('Galley');
    // divert on the renamed node still points at Home (untouched).
    expect(res.body.story_graph.nodes.Galley.divert).toBe('Home');
    expect(consumedAll()).toBe(true);
  });

  it("rewrites startNode when the renamed node was the story's start", async () => {
    const storyGraph = graph('Start', {
      Start: { choices: [], divert: null, parent: null },
      Other: { choices: [{ text: 'go', target: 'Start' }], divert: null, parent: null },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: /UPDATE project_stories/ },
      { match: /UPDATE node_audio_assignments\b/ },
      { match: /UPDATE node_metadata\b/ },
      { match: /UPDATE projects/ },
      { match: 'COMMIT' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'Start', newId: 'Intro' });
    expect(res.status).toBe(200);
    expect(res.body.story_graph.startNode).toBe('Intro');
    expect(res.body.story_graph.nodes.Other.choices[0].target).toBe('Intro');
  });

  it("returns 404 when the old id doesn't exist", async () => {
    const storyGraph = graph('Home', { Home: { choices: [], divert: null, parent: null } });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'Ghost', newId: 'Phantom' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the new id is already taken', async () => {
    const storyGraph = graph('Home', {
      Home: { choices: [], divert: null, parent: null },
      Kitchen: { choices: [], divert: null, parent: null },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'Home', newId: 'Kitchen' });
    expect(res.status).toBe(409);
  });

  it('400 on empty or equal ids without opening a transaction', async () => {
    const { pool, clientQuery } = makePool([]);
    const app = makeApp(pool);

    const r1 = await request(app)
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: '', newId: 'X' });
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'X', newId: 'X' });
    expect(r2.status).toBe(400);

    // Both bailed before BEGIN, so no client queries ran.
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('rejects Twee-unsafe names when source_language is twee', async () => {
    const storyGraph = graph('Home', { Home: { choices: [], divert: null, parent: null } });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'twee' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'Home', newId: 'Home->Foyer' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Twee/);
  });

  it('is prototype-safe on the old id (nodeId="toString" resolves to 404, not a crash)', async () => {
    const storyGraph = graph('Home', { Home: { choices: [], divert: null, parent: null } });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'toString', newId: 'Foo' });
    // Without Object.hasOwn the check would treat toString as
    // present (Object.prototype.toString), skip the 404, then crash
    // in the rewrite loop. Object.hasOwn returns false → 404.
    expect(res.status).toBe(404);
  });

  it("updates renamedNode.id so downstream reads of node.id don't render the stale name", async () => {
    const storyGraph = graph('Home', {
      Home: { id: 'Home', choices: [], divert: null, parent: null },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: /UPDATE project_stories/ },
      { match: /UPDATE node_audio_assignments\b/ },
      { match: /UPDATE node_metadata\b/ },
      { match: /UPDATE projects/ },
      { match: 'COMMIT' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'Home', newId: 'Foyer' });
    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.Foyer.id).toBe('Foyer');
  });

  it('re-keys stitches under a renamed knot AND rewrites references to them', async () => {
    // Ink authoring: knot `foo` with stitches `foo.a`, `foo.b`. A
    // choice from an unrelated knot targets `foo.a`. Renaming `foo`
    // → `bar` must produce stitches `bar.a`, `bar.b` and rewrite the
    // choice target to `bar.a`.
    const storyGraph = graph('Other', {
      foo: { id: 'foo', choices: [], divert: null, parent: null },
      'foo.a': { id: 'foo.a', choices: [], divert: null, parent: 'foo' },
      'foo.b': { id: 'foo.b', choices: [], divert: null, parent: 'foo' },
      Other: {
        id: 'Other',
        choices: [{ text: 'go', target: 'foo.a' }],
        divert: 'foo',
        parent: null,
      },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: /UPDATE project_stories/ },
      { match: /UPDATE node_audio_assignments\b/ },
      { match: /UPDATE node_metadata\b/ },
      { match: /UPDATE projects/ },
      { match: 'COMMIT' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'foo', newId: 'bar' });
    expect(res.status).toBe(200);
    const g = res.body.story_graph;
    expect(Object.keys(g.nodes).sort()).toEqual(['Other', 'bar', 'bar.a', 'bar.b']);
    expect(g.nodes['bar.a'].id).toBe('bar.a');
    expect(g.nodes['bar.a'].parent).toBe('bar');
    expect(g.nodes['bar.b'].parent).toBe('bar');
    // The choice / divert targeting `foo.a` and `foo` from Other were
    // both rewritten to the new prefix.
    expect(g.nodes.Other.choices[0].target).toBe('bar.a');
    expect(g.nodes.Other.divert).toBe('bar');
  });

  it('still responds 200 when invalidateRoom fails after COMMIT (transaction was committed; peers reconnect on next fetch)', async () => {
    // Mock invalidateRoom to reject. The rename must still return
    // 200 because the DB is already consistent — the collab-server
    // hiccup is logged, not surfaced as a 500.
    const collab = jest.requireMock('../../services/collab-server.js') as {
      invalidateRoom: jest.Mock<() => Promise<void>>;
    };
    collab.invalidateRoom.mockImplementationOnce(async () => {
      throw new Error('collab-server offline');
    });
    const storyGraph = graph('Home', {
      Home: { id: 'Home', choices: [], divert: null, parent: null },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: /UPDATE project_stories/ },
      { match: /UPDATE node_audio_assignments\b/ },
      { match: /UPDATE node_metadata\b/ },
      { match: /UPDATE projects/ },
      { match: 'COMMIT' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'Home', newId: 'Foyer' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    collab.invalidateRoom.mockReset();
  });

  it('409 on stitch-collision cascade — refuses to overwrite an existing node under the new prefix', async () => {
    // Renaming knot `foo` → `bar` would re-key `foo.a` to `bar.a`,
    // but the graph already has a node at `bar.a`. Refuse to
    // silently overwrite it — the author needs to rename the
    // collision first.
    const storyGraph = graph('foo', {
      foo: { id: 'foo', choices: [], divert: null, parent: null },
      'foo.a': { id: 'foo.a', choices: [], divert: null, parent: 'foo' },
      'bar.a': { id: 'bar.a', choices: [], divert: null, parent: null },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'foo', newId: 'bar' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/bar\.a/);
  });

  it("side-table update doesn't misfire on oldIds containing SQL LIKE wildcards", async () => {
    // `LIKE $2 || '.%'` would treat `%` and `_` inside oldId as
    // wildcards, so renaming e.g. `foo%bar` would migrate rows for
    // `foobar.baz`. The fix uses `left(node_id, length($2)+1)`
    // instead. We can't observe the raw SQL comparison in a mock,
    // but we can at least verify the endpoint accepts a wildcard-
    // shaped id and dispatches the update query (no throw, 200).
    const storyGraph = graph('Home', {
      a_b: { id: 'a_b', choices: [], divert: null, parent: null },
      Home: { id: 'Home', choices: [], divert: null, parent: null },
    });
    const { pool, clientQuery } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: /UPDATE project_stories/ },
      { match: /UPDATE node_audio_assignments\b/ },
      { match: /UPDATE node_metadata\b/ },
      { match: /UPDATE projects/ },
      { match: 'COMMIT' },
    ]);
    const res = await request(makeApp(pool))
      .patch(`/api/projects/${projectId}/story/node/rename`)
      .send({ oldId: 'a_b', newId: 'renamed' });
    expect(res.status).toBe(200);
    // Every side-table UPDATE we captured must use `left(...)`, not
    // `LIKE`.
    const sideTableCalls = clientQuery.mock.calls
      .map(([sql]) => sql as string)
      .filter((sql) => /UPDATE (node_audio_assignments|node_metadata)\b/.test(sql));
    expect(sideTableCalls.length).toBe(2);
    for (const sql of sideTableCalls) {
      expect(sql).toMatch(/left\(node_id, length\(\$2\) \+ 1\) = \$2 \|\| '\.'/);
      expect(sql).not.toMatch(/LIKE/);
    }
  });
});
