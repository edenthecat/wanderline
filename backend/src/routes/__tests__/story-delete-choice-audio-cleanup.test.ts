import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

// DEV-199 per-choice audio: a choice:<id> assignment dies with its
// choice — nothing else ever re-parents or garbage-collects it, so
// DELETE /story/choice has to clean it up itself or it's orphaned
// forever. The ordinal choice1/choice2 slots are deliberately left
// alone: they belong to a POSITION, not this specific choice.
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

function graph(nodes: Record<string, unknown>) {
  return {
    id: 'g1',
    title: 'T',
    startNode: Object.keys(nodes)[0],
    nodes,
    validation: { valid: true, errors: [], warnings: [] },
  };
}

function makeApp(storyGraph: unknown) {
  const queries: { sql: string; params: unknown[] }[] = [];
  let saved: unknown = storyGraph;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('SELECT story_graph')) {
      return { rows: [{ story_graph: saved }] };
    }
    if (sql.includes('UPDATE project_stories')) {
      saved = JSON.parse(params[0] as string);
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
  return { app, queries };
}

describe('DELETE /:id/story/choice', () => {
  it('deletes the choice:<id> audio assignment for a deleted choice that has an id', async () => {
    const { app, queries } = makeApp(
      graph({
        a: {
          id: 'a',
          content: [],
          choices: [{ text: 'go', target: 'b', id: 'choice-xyz' }],
          tags: [],
        },
      }),
    );
    const res = await request(app)
      .delete('/api/projects/p1/story/choice')
      .send({ nodeId: 'a', choiceIndex: 0 });

    expect(res.status).toBe(200);
    const cleanup = queries.find((q) => q.sql.includes('DELETE FROM node_audio_assignments'));
    expect(cleanup).toBeDefined();
    expect(cleanup!.params).toEqual(['p1', 'a', 'choice:choice-xyz']);
  });

  it('does not attempt audio cleanup for a choice with no id', async () => {
    const { app, queries } = makeApp(
      graph({
        a: { id: 'a', content: [], choices: [{ text: 'go', target: 'b' }], tags: [] },
      }),
    );
    const res = await request(app)
      .delete('/api/projects/p1/story/choice')
      .send({ nodeId: 'a', choiceIndex: 0 });

    expect(res.status).toBe(200);
    expect(queries.some((q) => q.sql.includes('DELETE FROM node_audio_assignments'))).toBe(false);
  });
});
