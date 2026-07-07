import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { mountBuildRoutes } from '../projects-builds.js';

// integration tests for the per-build preview route.
//
// The route lives in projects-builds.ts; we cover only the preview
// branches here. Build creation / download / delete are already
// exercised by cypress/e2e/builds.cy.ts and the unit tests in
// build-service.test.ts.
//
// renderPreviewHtml needs the player template on disk, so we point
// PLAYER_DIST at a tmp dir with a minimal index.html for each test.

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDist: string;
let prevPlayerDist: string | undefined;

beforeAll(() => {
  tmpDist = mkdtempSync(join(tmpdir(), 'wanderline-player-dist-'));
  writeFileSync(
    join(tmpDist, 'index.html'),
    `<!doctype html><html><head><title>Player</title></head><body><div id="root"></div></body></html>`,
  );
  prevPlayerDist = process.env.PLAYER_DIST;
  process.env.PLAYER_DIST = tmpDist;
});

afterAll(() => {
  process.env.PLAYER_DIST = prevPlayerDist;
  rmSync(tmpDist, { recursive: true, force: true });
});

function makeApp(pool: Pool) {
  const app = express();
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
  mountBuildRoutes(router, pool);
  app.use('/api/projects', router);
  return app;
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

describe('GET /api/projects/:id/builds/:buildId/preview', () => {
  const SNAPSHOT = {
    id: 'story1',
    title: 'Snapshot Story',
    audioBaseUrl: '/api/projects/p1/preview/audio/',
    startNode: 'start',
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [],
        choices: [],
        divert: null,
        tags: [],
        audio: {},
      },
    },
  };

  it('404s when the build does not exist for the project', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/preview');
    expect(res.status).toBe(404);
  });

  it('409s when the build exists but has no story_snapshot (older or in-progress)', async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            story_snapshot: null,
            status: 'completed',
            build_number: 1,
            label: null,
            project_name: 'Test',
          },
        ],
      }),
    ]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/preview');
    expect(res.status).toBe(409);
  });

  it('serves the player HTML with a "Build #N" banner and the snapshot inlined', async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            story_snapshot: SNAPSHOT,
            status: 'completed',
            build_number: 3,
            label: 'rc-3',
            project_name: 'Test Story',
          },
        ],
      }),
    ]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/preview');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/window\.__WANDERLINE_STORY__/);
    expect(res.text).toMatch(/Build #3 — rc-3/);
  });

  it('rewrites the snapshot audioBaseUrl to the per-build audio path', async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            story_snapshot: SNAPSHOT,
            status: 'completed',
            build_number: 1,
            label: null,
            project_name: 'P',
          },
        ],
      }),
    ]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/preview');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/\/api\/projects\/p1\/builds\/b1\/preview\/audio\//);
    expect(res.text).not.toMatch(/"audioBaseUrl":"\/api\/projects\/p1\/preview\/audio\//);
  });
});

describe('GET /api/projects/:id/builds/:buildId/preview/audio/:filename (+ )', () => {
  it('404s when the parent build is missing', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/preview/audio/x.mp3');
    expect(res.status).toBe(404);
  });

  it('404s when neither the zip cache nor the current project carries the file', async () => {
    // introduces a zip-cache lookup ahead of the audio_files
    // fallback, so the route issues 3 queries before giving up:
    //   1. project_builds existence check (route level)
    //   2. project_builds artifact_path lookup (inside
    //      resolveBuildPreviewAudio — returns null when the build has
    //      no artifact_path, which short-circuits the zip path)
    //   3. audio_files fallback (empty rows → 404)
    const { pool } = makePool([
      () => ({ rows: [{ '?column?': 1 }] }), // build exists at route level
      () => ({ rows: [{ artifact_path: null, status: 'completed' }] }), // no artifact, no zip cache
      () => ({ rows: [] }), // audio_files lookup empty → final 404
    ]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/preview/audio/x.mp3');
    expect(res.status).toBe(404);
  });
});
