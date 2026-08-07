import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountPreviewRoutes, _resetPreviewCachesForTests } from '../projects-preview.js';
import { buildStoryData } from '../../services/story-data-builder.js';

// Coverage for what the two server-served preview routes are allowed to
// tell the browser about a project's story password.
//
// Bug (b) in this change set: the player gated on
// `story.settings.password`, with no notion of which preview it was
// running in. In the editor that walled an author out of their own
// theme editor behind a password they had just set. Stripping the
// password from the authed payload is what removes the gate, and the
// same strip is what stops the public preview from shipping its own
// key next to the lock.

const PASSWORD = 'hunter2';

let tmpDist: string;
beforeAll(() => {
  tmpDist = mkdtempSync(join(tmpdir(), 'wanderline-pw-exposure-'));
  mkdirSync(join(tmpDist, 'assets'), { recursive: true });
  writeFileSync(
    join(tmpDist, 'index.html'),
    `<!doctype html><html><head><title>Player</title><script type="module" crossorigin src="./assets/index-abcdef.js"></script></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(tmpDist, 'assets', 'index-abcdef.js'), '/* fake bundle */');
  process.env.PLAYER_DIST = tmpDist;
  _resetPreviewCachesForTests();
});
afterAll(() => {
  delete process.env.PLAYER_DIST;
  _resetPreviewCachesForTests();
});

function attachLog(app: express.Express) {
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof console }).log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as typeof console;
    next();
  });
}

function makePool(handlers: Array<(sql: string, params: unknown[]) => unknown>) {
  let i = 0;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const fn = handlers[i++];
    if (!fn) throw new Error(`unexpected query #${i}: ${sql.slice(0, 80)}`);
    return fn(sql, params ?? []);
  });
  const connect = jest.fn(async () => ({ query, release: () => undefined }));
  return { pool: { query, connect } as unknown as Pool, query };
}

function storyDataHandlers(settings: Record<string, unknown>): Array<() => unknown> {
  return [
    () => ({
      rows: [
        {
          id: 'p1',
          name: 'My Story',
          story_graph: {
            id: 'sg1',
            title: 'My Story',
            startNode: 'n1',
            nodes: { n1: { id: 'n1', text: 'Once upon a time.', choices: [] } },
          },
          settings,
        },
      ],
    }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
  ];
}

describe('buildStoryData — passwordExposure', () => {
  it("embeds the password by default, for the build pipeline's benefit", async () => {
    const { pool } = makePool(storyDataHandlers({ password: PASSWORD }));
    const { storyData } = await buildStoryData(pool, 'p1', { audioBaseUrl: '/a/' });
    expect(storyData.settings?.password).toBe(PASSWORD);
  });

  it('embeds the password when asked to explicitly', async () => {
    const { pool } = makePool(storyDataHandlers({ password: PASSWORD }));
    const { storyData } = await buildStoryData(pool, 'p1', {
      audioBaseUrl: '/a/',
      passwordExposure: 'embed',
    });
    expect(storyData.settings?.password).toBe(PASSWORD);
  });

  it('omits the password when asked to', async () => {
    const { pool } = makePool(storyDataHandlers({ password: PASSWORD }));
    const { storyData } = await buildStoryData(pool, 'p1', {
      audioBaseUrl: '/a/',
      passwordExposure: 'omit',
    });
    expect(storyData.settings?.password).toBeUndefined();
  });

  // Omitting the password must not disturb the other settings that ride
  // in the same object.
  it('leaves the rest of settings intact when omitting', async () => {
    const { pool } = makePool(
      storyDataHandlers({
        password: PASSWORD,
        voiceoverVolume: 0.8,
        captionsDefault: true,
        showProgressBar: false,
      }),
    );
    const { storyData } = await buildStoryData(pool, 'p1', {
      audioBaseUrl: '/a/',
      passwordExposure: 'omit',
    });
    expect(storyData.settings?.password).toBeUndefined();
    expect(storyData.settings?.voiceoverVolume).toBe(0.8);
    expect(storyData.settings?.captionsDefault).toBe(true);
    expect(storyData.settings?.showProgressBar).toBe(false);
  });

  it('is a no-op on a project with no password set', async () => {
    const { pool } = makePool(storyDataHandlers({ voiceoverVolume: 0.5 }));
    const { storyData } = await buildStoryData(pool, 'p1', {
      audioBaseUrl: '/a/',
      passwordExposure: 'omit',
    });
    expect(storyData.settings?.password).toBeUndefined();
    expect(storyData.settings?.voiceoverVolume).toBe(0.5);
  });
});

describe('GET /api/projects/:id/preview — the authed editor preview', () => {
  function makeApp(pool: Pool) {
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPreviewRoutes(router, pool);
    app.use('/api/projects', router);
    return app;
  }

  it('serves the story for a password-protected project without any gate', async () => {
    const { pool } = makePool(storyDataHandlers({ password: PASSWORD }));
    const res = await request(makeApp(pool)).get('/api/projects/p1/preview');
    expect(res.status).toBe(200);
    expect(res.text).toContain('My Story');
  });

  // This is the assertion that fixes the editor: with no password in
  // the payload the player has nothing to gate on and renders the story
  // directly, so the author can actually use the theme editor.
  it('does not ship the password to the browser', async () => {
    const { pool } = makePool(storyDataHandlers({ password: PASSWORD }));
    const res = await request(makeApp(pool)).get('/api/projects/p1/preview');
    expect(res.text).not.toContain(PASSWORD);
  });

  it('still serves an unprotected project unchanged', async () => {
    const { pool } = makePool(storyDataHandlers({}));
    const res = await request(makeApp(pool)).get('/api/projects/p1/preview');
    expect(res.status).toBe(200);
    expect(res.text).toContain('My Story');
  });
});
