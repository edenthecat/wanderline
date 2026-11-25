import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

// Covers the three new DEV-199 Phase 5 routes: condition-editing for
// choices and text blocks, and whole-array variable replacement.
// Same mocking shape as story-rename-node.test.ts — unstable_mockModule
// (not jest.mock) because this project runs Jest in ESM.
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

function makeApp(storyGraph: unknown) {
  let saved: unknown = null;
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('SELECT story_graph')) {
      return { rows: [{ story_graph: saved ?? storyGraph }] };
    }
    if (sql.includes('UPDATE project_stories')) {
      // args aren't captured here; the route re-SELECTs its own
      // in-memory mutation, so we just need the row to keep existing.
      saved = storyGraph;
      return { rows: [] };
    }
    return { rows: [] };
  });
  const pool = { query, connect: jest.fn() } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };
    next();
  });
  const router = express.Router();
  mountStoryRoutes(router, pool);
  app.use('/api/projects', router);
  return { app, query };
}

function graph(nodes: Record<string, unknown>, variables?: unknown[]) {
  return {
    id: 'g1',
    title: 'T',
    startNode: Object.keys(nodes)[0],
    nodes,
    validation: { valid: true, errors: [], warnings: [] },
    ...(variables ? { variables } : {}),
  };
}

describe('PATCH /:id/story/choice/condition', () => {
  it('sets a parsed condition on the choice', async () => {
    const { app } = makeApp(
      graph({ a: { id: 'a', content: [], choices: [{ text: 'go', target: 'b' }], tags: [] } }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/choice/condition')
      .send({ nodeId: 'a', choiceIndex: 0, condition: 'gold > 10' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.a.choices[0].condition).toEqual({
      kind: 'binary',
      operator: '>',
      left: { kind: 'variable', name: 'gold' },
      right: { kind: 'literal', value: 10 },
    });
  });

  it('clears the condition when given null', async () => {
    const { app } = makeApp(
      graph({
        a: {
          id: 'a',
          content: [],
          choices: [{ text: 'go', target: 'b', condition: { kind: 'literal', value: true } }],
          tags: [],
        },
      }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/choice/condition')
      .send({ nodeId: 'a', choiceIndex: 0, condition: null });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.a.choices[0].condition).toBeNull();
  });

  it('rejects an unparseable condition with the parser message', async () => {
    const { app } = makeApp(
      graph({ a: { id: 'a', content: [], choices: [{ text: 'go', target: 'b' }], tags: [] } }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/choice/condition')
      .send({ nodeId: 'a', choiceIndex: 0, condition: 'gold >>' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('404s when the choice index is out of range', async () => {
    const { app } = makeApp(graph({ a: { id: 'a', content: [], choices: [], tags: [] } }));
    const res = await request(app)
      .patch('/api/projects/p1/story/choice/condition')
      .send({ nodeId: 'a', choiceIndex: 0, condition: null });

    expect(res.status).toBe(400);
  });

  it('404s for a __proto__ nodeId instead of resolving to Object.prototype', async () => {
    const { app } = makeApp(
      graph({ a: { id: 'a', content: [], choices: [{ text: 'go', target: 'b' }], tags: [] } }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/choice/condition')
      .send({ nodeId: '__proto__', choiceIndex: 0, condition: null });

    expect(res.status).toBe(404);
    // Object.prototype itself must come out unscathed — a naive
    // `storyGraph.nodes[nodeId]` truthy check would resolve
    // `nodeId: '__proto__'` to Object.prototype (always truthy) and
    // then write `.choices[0].condition` onto it, corrupting every
    // plain object in the process.
    expect(Object.prototype).not.toHaveProperty('choices');
  });

  it('parses a LIST-member condition against the story graph’s own LIST declarations', async () => {
    const kettleState = {
      name: 'kettleState',
      type: 'list',
      isConst: false,
      listMembers: ['cold', 'boiling', 'recently_boiled'],
      initialValue: {
        kind: 'literal',
        value: {
          kind: 'list',
          origin: 'kettleState',
          items: [{ name: 'cold', ordinal: 0 }],
          allItems: [
            { name: 'cold', ordinal: 0 },
            { name: 'boiling', ordinal: 1 },
            { name: 'recently_boiled', ordinal: 2 },
          ],
        },
      },
    };
    const { app } = makeApp(
      graph({ a: { id: 'a', content: [], choices: [{ text: 'go', target: 'b' }], tags: [] } }, [
        kettleState,
      ]),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/choice/condition')
      .send({ nodeId: 'a', choiceIndex: 0, condition: 'kettleState has boiling' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.a.choices[0].condition).toEqual({
      kind: 'binary',
      operator: 'has',
      left: { kind: 'variable', name: 'kettleState' },
      right: {
        kind: 'literal',
        value: {
          kind: 'list',
          origin: 'kettleState',
          items: [{ name: 'boiling', ordinal: 1 }],
          allItems: [
            { name: 'cold', ordinal: 0 },
            { name: 'boiling', ordinal: 1 },
            { name: 'recently_boiled', ordinal: 2 },
          ],
        },
      },
    });
  });

  it('parses a multi-member LIST literal condition, which fails outright without list context', async () => {
    const kettleState = {
      name: 'kettleState',
      type: 'list',
      isConst: false,
      listMembers: ['cold', 'boiling'],
      initialValue: {
        kind: 'literal',
        value: { kind: 'list', origin: 'kettleState', items: [], allItems: [] },
      },
    };
    const { app } = makeApp(
      graph({ a: { id: 'a', content: [], choices: [{ text: 'go', target: 'b' }], tags: [] } }, [
        kettleState,
      ]),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/choice/condition')
      .send({ nodeId: 'a', choiceIndex: 0, condition: 'kettleState == (cold, boiling)' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.a.choices[0].condition.right).toEqual({
      kind: 'literal',
      value: {
        kind: 'list',
        origin: 'kettleState',
        items: [
          { name: 'cold', ordinal: 0 },
          { name: 'boiling', ordinal: 1 },
        ],
        allItems: [
          { name: 'cold', ordinal: 0 },
          { name: 'boiling', ordinal: 1 },
        ],
      },
    });
  });
});

describe('PATCH /:id/story/node/content/condition', () => {
  it('sets a parsed condition on a text block', async () => {
    const { app } = makeApp(
      graph({
        a: { id: 'a', content: [{ kind: 'text', text: 'hi', tags: [] }], choices: [], tags: [] },
      }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/condition')
      .send({ nodeId: 'a', contentIndex: 0, condition: 'seenIntro == true' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.a.content[0].condition).toEqual({
      kind: 'binary',
      operator: '==',
      left: { kind: 'variable', name: 'seenIntro' },
      right: { kind: 'literal', value: true },
    });
  });

  it('clears the condition field entirely when given null', async () => {
    const { app } = makeApp(
      graph({
        a: {
          id: 'a',
          content: [
            { kind: 'text', text: 'hi', tags: [], condition: { kind: 'literal', value: true } },
          ],
          choices: [],
          tags: [],
        },
      }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/condition')
      .send({ nodeId: 'a', contentIndex: 0, condition: null });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.a.content[0]).not.toHaveProperty('condition');
  });

  it('rejects setting a condition on an assignment block', async () => {
    const { app } = makeApp(
      graph({
        a: {
          id: 'a',
          content: [
            {
              kind: 'assignment',
              statement: {
                kind: 'assignment',
                name: 'x',
                operator: '=',
                value: { kind: 'literal', value: 1 },
              },
            },
          ],
          choices: [],
          tags: [],
        },
      }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/condition')
      .send({ nodeId: 'a', contentIndex: 0, condition: 'true' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assignment block/);
  });

  it('404s for a __proto__ nodeId instead of resolving to Object.prototype', async () => {
    const { app } = makeApp(
      graph({
        a: { id: 'a', content: [{ kind: 'text', text: 'hi', tags: [] }], choices: [], tags: [] },
      }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/condition')
      .send({ nodeId: '__proto__', contentIndex: 0, condition: 'true' });

    expect(res.status).toBe(404);
    expect(Object.prototype).not.toHaveProperty('content');
  });

  it('parses a LIST-member condition against the story graph’s own LIST declarations', async () => {
    const kettleState = {
      name: 'kettleState',
      type: 'list',
      isConst: false,
      listMembers: ['cold', 'boiling'],
      initialValue: {
        kind: 'literal',
        value: { kind: 'list', origin: 'kettleState', items: [], allItems: [] },
      },
    };
    const { app } = makeApp(
      graph(
        {
          a: { id: 'a', content: [{ kind: 'text', text: 'hi', tags: [] }], choices: [], tags: [] },
        },
        [kettleState],
      ),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/condition')
      .send({ nodeId: 'a', contentIndex: 0, condition: 'kettleState hasnt cold' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.a.content[0].condition).toEqual({
      kind: 'binary',
      operator: 'hasnt',
      left: { kind: 'variable', name: 'kettleState' },
      right: {
        kind: 'literal',
        value: {
          kind: 'list',
          origin: 'kettleState',
          items: [{ name: 'cold', ordinal: 0 }],
          allItems: [
            { name: 'cold', ordinal: 0 },
            { name: 'boiling', ordinal: 1 },
          ],
        },
      },
    });
  });
});

describe('PATCH /:id/story/variables', () => {
  it('replaces the variable list, inferring type from initialValue', async () => {
    const { app } = makeApp(graph({ a: { id: 'a', content: [], choices: [], tags: [] } }));
    const res = await request(app)
      .patch('/api/projects/p1/story/variables')
      .send({
        variables: [
          { name: 'gold', initialValue: '10', isConst: false },
          { name: 'playerName', initialValue: '"Alex"', isConst: false },
          { name: 'MAX_GOLD', initialValue: '100', isConst: true },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.variables).toEqual([
      {
        name: 'gold',
        type: 'number',
        initialValue: { kind: 'literal', value: 10 },
        isConst: false,
      },
      {
        name: 'playerName',
        type: 'string',
        initialValue: { kind: 'literal', value: 'Alex' },
        isConst: false,
      },
      {
        name: 'MAX_GOLD',
        type: 'number',
        initialValue: { kind: 'literal', value: 100 },
        isConst: true,
      },
    ]);
  });

  it('lets a later declaration reference an earlier one', async () => {
    const { app } = makeApp(graph({ a: { id: 'a', content: [], choices: [], tags: [] } }));
    const res = await request(app)
      .patch('/api/projects/p1/story/variables')
      .send({
        variables: [
          { name: 'base', initialValue: '10', isConst: false },
          { name: 'doubled', initialValue: 'base * 2', isConst: false },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.variables[1].initialValue).toEqual({
      kind: 'binary',
      operator: '*',
      left: { kind: 'variable', name: 'base' },
      right: { kind: 'literal', value: 2 },
    });
  });

  it('rejects a duplicate name', async () => {
    const { app } = makeApp(graph({ a: { id: 'a', content: [], choices: [], tags: [] } }));
    const res = await request(app)
      .patch('/api/projects/p1/story/variables')
      .send({
        variables: [
          { name: 'gold', initialValue: '1', isConst: false },
          { name: 'gold', initialValue: '2', isConst: false },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  it('rejects an invalid identifier', async () => {
    const { app } = makeApp(graph({ a: { id: 'a', content: [], choices: [], tags: [] } }));
    const res = await request(app)
      .patch('/api/projects/p1/story/variables')
      .send({ variables: [{ name: '1bad', initialValue: '1', isConst: false }] });

    expect(res.status).toBe(400);
  });

  it('rejects an initialValue that references an undeclared variable', async () => {
    const { app } = makeApp(graph({ a: { id: 'a', content: [], choices: [], tags: [] } }));
    const res = await request(app)
      .patch('/api/projects/p1/story/variables')
      .send({ variables: [{ name: 'x', initialValue: 'undeclaredVar + 1', isConst: false }] });

    expect(res.status).toBe(400);
  });

  // Regression: Boolean(entry?.isConst) coerced the string "false"
  // (any non-boolean truthy value, really) to true — the opposite of
  // what a non-UI caller sending isConst: "false" would mean.
  it('treats a non-boolean isConst as false rather than coercing it to true', async () => {
    const { app } = makeApp(graph({ a: { id: 'a', content: [], choices: [], tags: [] } }));
    const res = await request(app)
      .patch('/api/projects/p1/story/variables')
      .send({ variables: [{ name: 'gold', initialValue: '1', isConst: 'false' }] });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.variables[0].isConst).toBe(false);
  });

  // Regression: a plain {} variableValues map let a declared name of
  // `__proto__` hit Object.prototype's accessor instead of being
  // stored as a real own property, so a later declaration reading it
  // back saw the inherited Object.prototype object instead of the
  // declared value.
  it('handles a variable literally named __proto__ as a normal declaration', async () => {
    const { app } = makeApp(graph({ a: { id: 'a', content: [], choices: [], tags: [] } }));
    const res = await request(app)
      .patch('/api/projects/p1/story/variables')
      .send({
        variables: [
          { name: '__proto__', initialValue: '5', isConst: false },
          { name: 'y', initialValue: '__proto__ + 1', isConst: false },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.variables[1].initialValue).toEqual({
      kind: 'binary',
      operator: '+',
      left: { kind: 'variable', name: '__proto__' },
      right: { kind: 'literal', value: 1 },
    });
  });

  // This route has no UI/schema for authoring a LIST's member
  // universe — VariablesTab only ever submits the project's SCALAR
  // variables. Before this fix, the route always wrote `variables`
  // as the complete replacement array, so an existing Ink-declared
  // LIST was silently dropped (or, if the client round-tripped its
  // printed form back through this scalar-only parser with no LIST
  // context, rejected outright) on every scalar-only save (found in
  // review).
  describe('preserves existing LIST declarations untouched', () => {
    const kettleState = {
      name: 'kettleState',
      type: 'list',
      isConst: false,
      listMembers: ['cold', 'boiling'],
      initialValue: {
        kind: 'literal',
        value: {
          kind: 'list',
          origin: 'kettleState',
          items: [{ name: 'cold', ordinal: 0 }],
          allItems: [
            { name: 'cold', ordinal: 0 },
            { name: 'boiling', ordinal: 1 },
          ],
        },
      },
    };

    it('keeps the LIST when the submitted array only contains scalars', async () => {
      const { app } = makeApp(
        graph({ a: { id: 'a', content: [], choices: [], tags: [] } }, [kettleState]),
      );
      const res = await request(app)
        .patch('/api/projects/p1/story/variables')
        .send({ variables: [{ name: 'gold', initialValue: '10', isConst: false }] });

      expect(res.status).toBe(200);
      expect(res.body.story_graph.variables).toEqual([
        kettleState,
        {
          name: 'gold',
          type: 'number',
          initialValue: { kind: 'literal', value: 10 },
          isConst: false,
        },
      ]);
    });

    it('keeps the LIST untouched across repeated scalar edits (create, then edit)', async () => {
      const { app } = makeApp(
        graph({ a: { id: 'a', content: [], choices: [], tags: [] } }, [kettleState]),
      );
      await request(app)
        .patch('/api/projects/p1/story/variables')
        .send({ variables: [{ name: 'gold', initialValue: '10', isConst: false }] });
      const res = await request(app)
        .patch('/api/projects/p1/story/variables')
        .send({ variables: [{ name: 'gold', initialValue: '20', isConst: false }] });

      expect(res.status).toBe(200);
      expect(res.body.story_graph.variables[0]).toEqual(kettleState);
      expect(res.body.story_graph.variables[1].initialValue).toEqual({
        kind: 'literal',
        value: 20,
      });
    });

    it('rejects a new scalar whose name collides with an existing LIST', async () => {
      const { app } = makeApp(
        graph({ a: { id: 'a', content: [], choices: [], tags: [] } }, [kettleState]),
      );
      const res = await request(app)
        .patch('/api/projects/p1/story/variables')
        .send({ variables: [{ name: 'kettleState', initialValue: '5', isConst: false }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already declared as a LIST/);
    });
  });
});

// Companion to the existing nodeId cases: a non-numeric index makes
// `node.choices[i]` / `node.content[i]` resolve to Array.prototype,
// so the following `.condition =` (or `delete`) would write through
// to every array. CodeQL alerts #92/#93/#94 flag those assignments;
// these pin the Number.isInteger guard that keeps them unreachable.
describe('prototype-polluting index on the condition routes', () => {
  const choiceGraph = () =>
    graph({ a: { id: 'a', content: [], choices: [{ text: 'go', target: 'b' }], tags: [] } });
  const contentGraph = () =>
    graph({
      a: { id: 'a', content: [{ kind: 'text', text: 'hi', tags: [] }], choices: [], tags: [] },
    });

  for (const index of ['__proto__', 'constructor', 'prototype']) {
    it(`400s for a ${index} choiceIndex without touching Array.prototype`, async () => {
      const { app, query } = makeApp(choiceGraph());
      const res = await request(app)
        .patch('/api/projects/p1/story/choice/condition')
        .send({ nodeId: 'a', choiceIndex: index, condition: 'gold > 1' });

      expect(res.status).toBe(400);
      expect(Array.prototype).not.toHaveProperty('condition');
      expect(Object.prototype).not.toHaveProperty('condition');
      expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false);
    });

    it(`400s for a ${index} contentIndex without touching Array.prototype`, async () => {
      const { app, query } = makeApp(contentGraph());
      const res = await request(app)
        .patch('/api/projects/p1/story/node/content/condition')
        .send({ nodeId: 'a', contentIndex: index, condition: 'gold > 1' });

      expect(res.status).toBe(400);
      expect(Array.prototype).not.toHaveProperty('condition');
      expect(Object.prototype).not.toHaveProperty('condition');
      expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false);
    });
  }

  // `condition: null` takes the `delete block.condition` branch
  // (alert #93) rather than the assignment branch.
  it('400s for a __proto__ contentIndex on the delete branch too', async () => {
    const { app } = makeApp(contentGraph());
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/condition')
      .send({ nodeId: 'a', contentIndex: '__proto__', condition: null });

    expect(res.status).toBe(400);
    expect(Array.prototype).not.toHaveProperty('condition');
  });
});
