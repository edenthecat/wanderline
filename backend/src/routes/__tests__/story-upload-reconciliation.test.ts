import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

// Re-uploading Ink/Twee (or compiled Ink JSON) source mints a fresh
// randomUUID() for every choice — without reconciling against the
// PREVIOUS graph's choice ids, per-choice audio (addressed by that
// id) silently disappears on every re-upload, even for
// byte-identical source. These are the integration-level tests for
// POST /ink, /twine, and /ink-json's reconciliation calls (the unit
// tests for the matching logic itself live in
// reconcile-choice-ids.test.ts). No prior test file exercised these
// upload routes at all.

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

/**
 * `existingStoryGraph` seeds what the route's reconciliation fetch
 * sees as the project's CURRENT row before this upload overwrites
 * it. `captureSnapshot`'s own internal queries (flush already
 * mocked above) get the generic `{ rows: [] }` fallback — which
 * makes it throw "Project has no story to snapshot" internally, but
 * the route wraps that call in its own try/catch and just logs it,
 * so it never affects the response under test.
 */
function makeApp(existingStoryGraph: unknown) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('SELECT id FROM projects WHERE id')) {
      return { rows: [{ id: 'p1' }] };
    }
    if (sql.includes('SELECT story_graph FROM project_stories WHERE project_id')) {
      return { rows: existingStoryGraph ? [{ story_graph: existingStoryGraph }] : [] };
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

function oldChoiceGraph(
  choices: { id: string; text: string; target: string }[],
  startNodeId = 'start',
) {
  return {
    id: 'old',
    title: 'Old',
    startNode: startNodeId,
    nodes: {
      [startNodeId]: {
        id: startNodeId,
        type: 'knot',
        parent: null,
        content: [],
        choices: choices.map((c) => ({ ...c, sticky: false, fallback: false, tags: [] })),
        divert: null,
        tags: [],
      },
      cave: {
        id: 'cave',
        type: 'knot',
        parent: null,
        content: [],
        choices: [],
        divert: null,
        tags: [],
      },
      beach: {
        id: 'beach',
        type: 'knot',
        parent: null,
        content: [],
        choices: [],
        divert: null,
        tags: [],
      },
    },
    validation: { valid: true, errors: [], warnings: [] },
  };
}

describe('POST /:id/ink — choice id reconciliation', () => {
  const INK_SOURCE = [
    '== start ==',
    'Hello.',
    '* Go north -> cave',
    '* Go south -> beach',
    '',
    '== cave ==',
    'Dark.',
    '',
    '== beach ==',
    'Sunny.',
    '',
  ].join('\n');

  it('carries forward the matching choice’s old id on re-upload', async () => {
    const { app } = makeApp(
      oldChoiceGraph([
        { id: 'old-north', text: 'Go north', target: 'cave' },
        { id: 'old-south', text: 'Go south', target: 'beach' },
      ]),
    );
    const res = await request(app).post('/api/projects/p1/ink').send({ source: INK_SOURCE });

    expect(res.status).toBe(200);
    const choices = res.body.story.nodes.start.choices;
    expect(choices.find((c: { text: string }) => c.text === 'Go north').id).toBe('old-north');
    expect(choices.find((c: { text: string }) => c.text === 'Go south').id).toBe('old-south');
  });

  it('is a no-op (keeps the fresh id) on a first-ever upload with no prior row', async () => {
    const { app } = makeApp(null);
    const res = await request(app).post('/api/projects/p1/ink').send({ source: INK_SOURCE });

    expect(res.status).toBe(200);
    const choices = res.body.story.nodes.start.choices;
    expect(typeof choices[0].id).toBe('string');
    expect(choices[0].id).not.toBe('old-north');
  });
});

describe('POST /:id/twine — choice id reconciliation', () => {
  const TWEE_SOURCE = [
    ':: StoryData',
    '{"start":"start"}',
    '',
    ':: start',
    'Hello.',
    '[[Go north->cave]]',
    '[[Go south->beach]]',
    '',
    ':: cave',
    'Dark.',
    '',
    ':: beach',
    'Sunny.',
    '',
  ].join('\n');

  it('carries forward the matching choice’s old id on re-upload', async () => {
    const { app } = makeApp(
      oldChoiceGraph([
        { id: 'old-north', text: 'Go north', target: 'cave' },
        { id: 'old-south', text: 'Go south', target: 'beach' },
      ]),
    );
    const res = await request(app).post('/api/projects/p1/twine').send({ source: TWEE_SOURCE });

    expect(res.status).toBe(200);
    const choices = res.body.story.nodes.start.choices;
    expect(choices.find((c: { text: string }) => c.text === 'Go north').id).toBe('old-north');
    expect(choices.find((c: { text: string }) => c.text === 'Go south').id).toBe('old-south');
  });
});

describe('POST /:id/ink-json — choice id reconciliation', () => {
  // A single choice with no preceding choiceTexts capture resolves
  // to the literal fallback text 'Choice 1' (see
  // ink-json-parser.ts) — matching the fixture already established
  // by ink-json-parser-ids.test.ts.
  function compiledInkJson() {
    return JSON.stringify({
      inkVersion: 21,
      root: [[{ 'c-0': [{ '->': 'END' }] }], null, {}],
      listDefs: {},
    });
  }

  it('carries forward the matching choice’s old id on re-upload', async () => {
    const { app } = makeApp(
      oldChoiceGraph([{ id: 'old-choice-1', text: 'Choice 1', target: 'END' }], '_intro'),
    );
    const res = await request(app)
      .post('/api/projects/p1/ink-json')
      .send({ source: compiledInkJson() });

    expect(res.status).toBe(200);
    const startNode = res.body.story.nodes[res.body.story.startNode];
    expect(startNode.choices[0].id).toBe('old-choice-1');
  });
});
