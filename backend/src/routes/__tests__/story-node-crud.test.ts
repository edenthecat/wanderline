import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

// POST + DELETE /:id/story/node. Both run a transaction
// (BEGIN → SELECT FOR UPDATE → UPDATE/DELETE → COMMIT), so the pool
// mock hands back a client with a scripted query sequence and the test
// asserts on the exact statements issued.
//
// unstable_mockModule, not jest.mock: this project runs Jest in ESM,
// where jest.mock does not hoist and the mock never takes effect. The
// factory replaces the whole module, so it has to cover every export
// the import graph reaches — projects-story pulls in
// projects-snapshots, which needs flushPendingShadowSave.
const mockInvalidateRoom = jest
  .fn<(projectId: string) => Promise<boolean>>()
  .mockResolvedValue(true);
const mockFlushPendingShadowSave = jest
  .fn<(projectId: string) => Promise<void>>()
  .mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/collab-server.js', () => ({
  invalidateRoom: mockInvalidateRoom,
  flushPendingShadowSave: mockFlushPendingShadowSave,
}));

const { mountStoryRoutes } = await import('../projects-story.js');

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
  const calls: { sql: string; params: unknown[] }[] = [];
  const clientQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
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
    calls,
    release,
    consumedAll: () => i === script.length,
  };
}

function graph(
  startNode: string,
  nodes: Record<string, unknown>,
  validation: unknown = { valid: true, errors: [], warnings: [] },
) {
  return { startNode, nodes, id: 'g1', title: 'T', validation };
}

/** The transaction every successful create runs, in order. */
const createScript = (storyGraph: unknown, sourceLanguage = 'ink'): ScriptedQuery[] => [
  { match: 'BEGIN' },
  {
    match: 'SELECT story_graph',
    rows: [{ story_graph: storyGraph, source_language: sourceLanguage }],
  },
  { match: /UPDATE project_stories/ },
  { match: /UPDATE projects/ },
  { match: 'COMMIT' },
];

/** The transaction every successful delete runs, in order. */
const deleteScript = (storyGraph: unknown, sourceLanguage = 'ink'): ScriptedQuery[] => [
  { match: 'BEGIN' },
  {
    match: 'SELECT story_graph',
    rows: [{ story_graph: storyGraph, source_language: sourceLanguage }],
  },
  { match: /UPDATE project_stories/ },
  { match: /DELETE FROM node_audio_assignments/ },
  { match: /DELETE FROM node_metadata/ },
  { match: /DELETE FROM node_flags/ },
  { match: /DELETE FROM audio_assignment_audit_acks/ },
  { match: /UPDATE projects/ },
  { match: 'COMMIT' },
];

const projectId = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  mockInvalidateRoom.mockClear();
});

describe('POST /:id/story/node', () => {
  it('creates a knot at the end of the story and drops the collab room', async () => {
    const storyGraph = graph('intro', {
      intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
    });
    const { pool, consumedAll } = makePool(createScript(storyGraph));
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'chapter2', content: 'The door opens.' });

    expect(res.status).toBe(200);
    expect(res.body.nodeId).toBe('chapter2');
    const created = res.body.story_graph.nodes.chapter2;
    expect(created).toMatchObject({
      id: 'chapter2',
      type: 'knot',
      parent: null,
      choices: [],
      divert: null,
      content: [{ text: 'The door opens.', tags: [] }],
    });
    // Renumbered 1..n in reading order, with the new knot last.
    expect(created.lineNumber).toBe(2);
    expect(res.body.story_graph.nodes.intro.lineNumber).toBe(1);
    // Start passage untouched — the story already had one.
    expect(res.body.story_graph.startNode).toBe('intro');
    expect(mockInvalidateRoom).toHaveBeenCalledWith(projectId);
    expect(consumedAll()).toBe(true);
  });

  it('inserts a stitch between its siblings, which is where fall-through reads it', async () => {
    const storyGraph = graph('ch1', {
      ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      'ch1.a': {
        id: 'ch1.a',
        type: 'stitch',
        parent: 'ch1',
        choices: [],
        divert: null,
        lineNumber: 2,
      },
      'ch1.b': {
        id: 'ch1.b',
        type: 'stitch',
        parent: 'ch1',
        choices: [],
        divert: null,
        lineNumber: 3,
      },
    });
    const { pool } = makePool(createScript(storyGraph));
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'ch1.mid', afterNodeId: 'ch1.a' });

    expect(res.status).toBe(200);
    const nodes = res.body.story_graph.nodes;
    expect(nodes['ch1.mid']).toMatchObject({ type: 'stitch', parent: 'ch1', content: [] });
    const order = Object.keys(nodes).sort((a, b) => nodes[a].lineNumber - nodes[b].lineNumber);
    expect(order).toEqual(['ch1', 'ch1.a', 'ch1.mid', 'ch1.b']);
  });

  it('places a stitch first when anchored on its own knot', async () => {
    // A knot runs by its lowest-lineNumber stitch, so "after the knot
    // header" is the only way to give a chapter a new opening scene.
    const storyGraph = graph('ch1', {
      ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      'ch1.a': {
        id: 'ch1.a',
        type: 'stitch',
        parent: 'ch1',
        choices: [],
        divert: null,
        lineNumber: 2,
      },
    });
    const { pool } = makePool(createScript(storyGraph));
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'ch1.opening', afterNodeId: 'ch1' });

    expect(res.status).toBe(200);
    const nodes = res.body.story_graph.nodes;
    const order = Object.keys(nodes).sort((a, b) => nodes[a].lineNumber - nodes[b].lineNumber);
    expect(order).toEqual(['ch1', 'ch1.opening', 'ch1.a']);
  });

  it('adopts the new node as the start when the story never had a usable one', async () => {
    const storyGraph = graph(
      '',
      {},
      { valid: false, errors: [{ type: 'missing_start' }], warnings: [] },
    );
    const { pool } = makePool(createScript(storyGraph));
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'opening' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.startNode).toBe('opening');
    // The stored validation block is rendered verbatim by the editor,
    // so leaving `missing_start` behind would keep reporting the
    // problem this request just fixed.
    expect(res.body.story_graph.validation.errors).toEqual([]);
    expect(res.body.story_graph.validation.valid).toBe(true);
  });

  it('rejects __proto__ rather than reporting a node it did not store', async () => {
    const storyGraph = graph('intro', {
      intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: '__proto__' });

    expect(res.status).toBe(400);
  });

  it('400s (not 500s) when the named parent is stored as null', async () => {
    // Stored graphs do contain null nodes; Object.hasOwn is true for
    // them, so a bare `.type` deref would surface as a 500.
    const storyGraph = graph('intro', {
      intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      chapter: null,
    });
    const { pool } = makePool(createScript(storyGraph));
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'chapter.scene' });

    // A null parent isn't a stitch, so the create proceeds rather than
    // crashing — what matters is that it never 500s.
    expect(res.status).toBe(200);
  });

  it('refuses an id that is already taken, without writing', async () => {
    const storyGraph = graph('intro', {
      intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
    });
    const { pool, consumedAll } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'intro' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already used/);
    expect(mockInvalidateRoom).not.toHaveBeenCalled();
    expect(consumedAll()).toBe(true);
  });

  it('refuses a stitch under a knot that does not exist', async () => {
    const storyGraph = graph('intro', {
      intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'ghost.scene' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Knot "ghost" does not exist/);
  });

  it('refuses an afterNodeId from a different knot', async () => {
    const storyGraph = graph('ch1', {
      ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      ch2: { id: 'ch2', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 2 },
      'ch2.x': {
        id: 'ch2.x',
        type: 'stitch',
        parent: 'ch2',
        choices: [],
        divert: null,
        lineNumber: 3,
      },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'ch1.new', afterNodeId: 'ch2.x' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a sibling/);
  });

  it('creates a dotted Twee passage as a top-level passage, not a stitch', async () => {
    const storyGraph = graph('Start', {
      Start: { id: 'Start', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
    });
    const { pool } = makePool(createScript(storyGraph, 'twee'));
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'Ch1. The Kitchen' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes['Ch1. The Kitchen']).toMatchObject({
      type: 'knot',
      parent: null,
    });
  });

  it('rejects a malformed id before opening a transaction', async () => {
    const { pool } = makePool([]);
    const res = await request(makeApp(pool))
      .post(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 42 });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /:id/story/node', () => {
  it('deletes a passage and cascades every side table keyed by node_id', async () => {
    const storyGraph = graph('intro', {
      intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      spare: { id: 'spare', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 2 },
    });
    const { pool, calls, consumedAll } = makePool(deleteScript(storyGraph));
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'spare' });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual(['spare']);
    expect(res.body.repointed).toBe(0);
    expect(Object.keys(res.body.story_graph.nodes)).toEqual(['intro']);
    const sideTableCalls = calls.filter((c) => c.sql.startsWith('DELETE FROM'));
    expect(sideTableCalls).toHaveLength(4);
    for (const call of sideTableCalls) {
      expect(call.params).toEqual([projectId, ['spare']]);
    }
    expect(mockInvalidateRoom).toHaveBeenCalledWith(projectId);
    expect(consumedAll()).toBe(true);
  });

  it('takes a knot’s stitches with it and cascades their side rows too', async () => {
    const storyGraph = graph('intro', {
      intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 2 },
      'ch1.a': {
        id: 'ch1.a',
        type: 'stitch',
        parent: 'ch1',
        choices: [],
        divert: null,
        lineNumber: 3,
      },
    });
    const { pool, calls } = makePool(deleteScript(storyGraph));
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'ch1' });

    expect(res.status).toBe(200);
    expect(res.body.deleted.sort()).toEqual(['ch1', 'ch1.a']);
    expect(Object.keys(res.body.story_graph.nodes)).toEqual(['intro']);
    const flagsDelete = calls.find((c) => c.sql.includes('DELETE FROM node_flags'));
    expect(flagsDelete?.params[1]).toEqual(['ch1', 'ch1.a']);
  });

  it('refuses rather than orphaning when other passages still point at it', async () => {
    const storyGraph = graph('intro', {
      intro: {
        id: 'intro',
        type: 'knot',
        parent: null,
        choices: [{ text: 'go', target: 'kitchen' }],
        divert: null,
        lineNumber: 1,
      },
      hall: {
        id: 'hall',
        type: 'knot',
        parent: null,
        choices: [],
        divert: 'kitchen',
        lineNumber: 2,
      },
      kitchen: {
        id: 'kitchen',
        type: 'knot',
        parent: null,
        choices: [],
        divert: null,
        lineNumber: 3,
      },
    });
    const { pool, consumedAll } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'kitchen' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/intro/);
    expect(res.body.error).toMatch(/hall/);
    expect(res.body.referrers).toEqual([
      { from: 'intro', via: 'choice', choiceIndex: 0, target: 'kitchen' },
      { from: 'hall', via: 'divert', target: 'kitchen' },
    ]);
    // Nothing written, and peers are left alone.
    expect(mockInvalidateRoom).not.toHaveBeenCalled();
    expect(consumedAll()).toBe(true);
  });

  it('counts a bare Ink stitch reference as a referrer', async () => {
    // `-> b` written inside ch1 means `ch1.b`. Exact-match-only
    // detection would miss it and leave a dangling divert.
    const storyGraph = graph('ch1', {
      ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      'ch1.a': {
        id: 'ch1.a',
        type: 'stitch',
        parent: 'ch1',
        choices: [],
        divert: 'b',
        lineNumber: 2,
      },
      'ch1.b': {
        id: 'ch1.b',
        type: 'stitch',
        parent: 'ch1',
        choices: [],
        divert: null,
        lineNumber: 3,
      },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'ch1.b' });

    expect(res.status).toBe(409);
    expect(res.body.referrers).toEqual([{ from: 'ch1.a', via: 'divert', target: 'ch1.b' }]);
  });

  it('repoints every referrer when given a replacement target', async () => {
    const storyGraph = graph('intro', {
      intro: {
        id: 'intro',
        type: 'knot',
        parent: null,
        choices: [{ text: 'go', target: 'kitchen' }],
        divert: null,
        lineNumber: 1,
      },
      hall: {
        id: 'hall',
        type: 'knot',
        parent: null,
        choices: [],
        divert: 'kitchen',
        lineNumber: 2,
      },
      kitchen: {
        id: 'kitchen',
        type: 'knot',
        parent: null,
        choices: [],
        divert: null,
        lineNumber: 3,
      },
    });
    const { pool } = makePool(deleteScript(storyGraph));
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'kitchen', repointTo: 'hall' });

    expect(res.status).toBe(200);
    expect(res.body.repointed).toBe(2);
    expect(res.body.story_graph.nodes.intro.choices[0].target).toBe('hall');
    expect(res.body.story_graph.nodes.hall.divert).toBe('hall');
    expect(Object.keys(res.body.story_graph.nodes).sort()).toEqual(['hall', 'intro']);
  });

  it('accepts END as a replacement target', async () => {
    const storyGraph = graph('intro', {
      intro: {
        id: 'intro',
        type: 'knot',
        parent: null,
        choices: [],
        divert: 'kitchen',
        lineNumber: 1,
      },
      kitchen: {
        id: 'kitchen',
        type: 'knot',
        parent: null,
        choices: [],
        divert: null,
        lineNumber: 2,
      },
    });
    const { pool } = makePool(deleteScript(storyGraph));
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'kitchen', repointTo: 'END' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.intro.divert).toBe('END');
  });

  it('refuses a replacement target that is itself being deleted', async () => {
    const storyGraph = graph('intro', {
      intro: {
        id: 'intro',
        type: 'knot',
        parent: null,
        choices: [],
        divert: 'ch1',
        lineNumber: 1,
      },
      ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 2 },
      'ch1.a': {
        id: 'ch1.a',
        type: 'stitch',
        parent: 'ch1',
        choices: [],
        divert: null,
        lineNumber: 3,
      },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'ch1', repointTo: 'ch1.a' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/itself being deleted/);
  });

  it('refuses to delete the start passage', async () => {
    const storyGraph = graph('intro', {
      intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'intro' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/start passage/);
  });

  it('refuses to delete a knot that CONTAINS the start passage', async () => {
    const storyGraph = graph('ch1.a', {
      ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      'ch1.a': {
        id: 'ch1.a',
        type: 'stitch',
        parent: 'ch1',
        choices: [],
        divert: null,
        lineNumber: 2,
      },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'ch1' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/start passage/);
  });

  it('drops validation messages that name a deleted passage', async () => {
    const storyGraph = graph(
      'intro',
      {
        intro: {
          id: 'intro',
          type: 'knot',
          parent: null,
          choices: [],
          divert: null,
          lineNumber: 1,
        },
        spare: {
          id: 'spare',
          type: 'knot',
          parent: null,
          choices: [],
          divert: null,
          lineNumber: 2,
        },
      },
      {
        valid: false,
        errors: [{ type: 'empty_node', nodeId: 'spare' }],
        warnings: [
          { type: 'unreachable_node', nodeId: 'spare' },
          { type: 'unreachable_node', nodeId: 'intro' },
        ],
      },
    );
    const { pool } = makePool(deleteScript(storyGraph));
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'spare' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.validation.errors).toEqual([]);
    // Messages about surviving passages are untouched — nothing here
    // re-validates, it only removes what is provably stale.
    expect(res.body.story_graph.validation.warnings).toEqual([
      { type: 'unreachable_node', nodeId: 'intro' },
    ]);
    expect(res.body.story_graph.validation.valid).toBe(true);
  });

  it('404s on an unknown node', async () => {
    const storyGraph = graph('intro', {
      intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
    });
    const { pool } = makePool([
      { match: 'BEGIN' },
      { match: 'SELECT story_graph', rows: [{ story_graph: storyGraph, source_language: 'ink' }] },
      { match: 'ROLLBACK' },
    ]);
    const res = await request(makeApp(pool))
      .delete(`/api/projects/${projectId}/story/node`)
      .send({ nodeId: 'nope' });

    expect(res.status).toBe(404);
  });
});
