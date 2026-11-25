import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

// PATCH /:id/story/node/content/text had no isTextBlock guard (unlike
// its sibling condition-editing routes) and used a bare truthy check
// on storyGraph.nodes[nodeId] instead of this file's own established
// Object.hasOwn convention (found in review). Same mocking shape as
// story-conditions-and-variables.test.ts.
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

function graph(nodes: Record<string, unknown>) {
  return {
    id: 'g1',
    title: 'T',
    startNode: Object.keys(nodes)[0],
    nodes,
    validation: { valid: true, errors: [], warnings: [] },
  };
}

describe('PATCH /:id/story/node/content/text', () => {
  it('updates a text block', async () => {
    const { app } = makeApp(
      graph({
        a: { id: 'a', content: [{ kind: 'text', text: 'old', tags: [] }], choices: [], tags: [] },
      }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/text')
      .send({ nodeId: 'a', contentIndex: 0, newText: 'new' });

    expect(res.status).toBe(200);
    expect(res.body.story_graph.nodes.a.content[0].text).toBe('new');
  });

  it('rejects setting text on an assignment block instead of corrupting it', async () => {
    const { app } = makeApp(
      graph({
        a: {
          id: 'a',
          content: [
            {
              kind: 'assignment',
              statement: {
                kind: 'assignment',
                name: 'gold',
                operator: '=',
                value: { kind: 'literal', value: 5 },
              },
            },
          ],
          choices: [],
          tags: [],
        },
      }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/text')
      .send({ nodeId: 'a', contentIndex: 0, newText: 'oops' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assignment block/);
    // The statement must survive untouched — not stamped with a
    // stray `.text` property.
    expect(res.body).not.toHaveProperty('story_graph');
  });

  it('404s when the content index is out of range', async () => {
    const { app } = makeApp(graph({ a: { id: 'a', content: [], choices: [], tags: [] } }));
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/text')
      .send({ nodeId: 'a', contentIndex: 0, newText: 'x' });

    expect(res.status).toBe(400);
  });

  it('404s for a __proto__ nodeId instead of resolving to Object.prototype', async () => {
    const { app } = makeApp(
      graph({
        a: { id: 'a', content: [{ kind: 'text', text: 'hi', tags: [] }], choices: [], tags: [] },
      }),
    );
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/text')
      .send({ nodeId: '__proto__', contentIndex: 0, newText: 'x' });

    expect(res.status).toBe(404);
    expect(Object.prototype).not.toHaveProperty('content');
  });
});

// The nodeId vector was already covered; the INDEX vector was not.
// `node.content[contentIndex]` with a non-numeric contentIndex
// resolves to Array.prototype, and the subsequent `block.text =`
// would then write onto it, polluting every array in the process.
// CodeQL flags that assignment (alert #102); these pin the
// Number.isInteger guard that makes it unreachable.
describe('PATCH /:id/story/node/content/text — prototype-polluting contentIndex', () => {
  const textGraph = () =>
    graph({
      a: { id: 'a', content: [{ kind: 'text', text: 'hi', tags: [] }], choices: [], tags: [] },
    });

  for (const contentIndex of ['__proto__', 'constructor', 'prototype']) {
    it(`400s for a ${contentIndex} contentIndex without touching Array.prototype`, async () => {
      const { app, query } = makeApp(textGraph());
      const res = await request(app)
        .patch('/api/projects/p1/story/node/content/text')
        .send({ nodeId: 'a', contentIndex, newText: 'pwned' });

      expect(res.status).toBe(400);
      expect(Array.prototype).not.toHaveProperty('text');
      expect(Object.prototype).not.toHaveProperty('text');
      expect(([] as unknown as { text?: string }).text).toBeUndefined();
      // Rejected before any write, not merely rejected after one.
      expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false);
    });
  }

  it('400s for a numeric-string contentIndex rather than coercing it', async () => {
    const { app } = makeApp(textGraph());
    const res = await request(app)
      .patch('/api/projects/p1/story/node/content/text')
      .send({ nodeId: 'a', contentIndex: '0', newText: 'coerced' });

    expect(res.status).toBe(400);
  });
});
