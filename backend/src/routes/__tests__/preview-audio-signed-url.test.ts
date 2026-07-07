import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import type { Pool } from 'pg';
import { mountPreviewRoutes } from '../projects-preview.js';
import { mountBuildRoutes } from '../projects-builds.js';
import {
  _setStorageForTests,
  resetStorageForTests,
  type ObjectStorage,
} from '../../services/storage.js';

// signed-URL 307 for preview audio.
//
// Same contract as the build-download slice (#122):
//   - USE_SIGNED_URL_DOWNLOADS=true + backend has a signed URL → 307.
//   - Flag off → existing stream through Cloud Run.
//   - Backend returns null → fall through to stream (410 later if
//     the object is truly gone).
//   - Backend throws → warn + fall through to stream (auth /
//     network outages don't take the audio path down).
//
// Coverage across BOTH preview audio routes: the live one on
// projects-preview.ts and the per-build (audio_files fallback) one
// on projects-builds.ts. Locking both in prevents drift as either
// route evolves.

function makeApp(mount: (router: express.Router) => void, _pool: Pool) {
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
  mount(router);
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

function makeStorage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  const notImplemented = (name: string) => () => {
    throw new Error(`ObjectStorage.${name} not stubbed in this test`);
  };
  return {
    uploadFile: notImplemented('uploadFile') as ObjectStorage['uploadFile'],
    downloadStream: notImplemented('downloadStream') as ObjectStorage['downloadStream'],
    delete: notImplemented('delete') as ObjectStorage['delete'],
    exists: notImplemented('exists') as ObjectStorage['exists'],
    size: notImplemented('size') as ObjectStorage['size'],
    signedGetUrl: notImplemented('signedGetUrl') as ObjectStorage['signedGetUrl'],
    ...overrides,
  };
}

describe('GET /api/projects/:id/preview/audio/:filename — signed URL redirects', () => {
  afterEach(() => {
    delete process.env.USE_SIGNED_URL_DOWNLOADS;
    resetStorageForTests();
  });

  it('streams the audio when USE_SIGNED_URL_DOWNLOADS is unset', async () => {
    delete process.env.USE_SIGNED_URL_DOWNLOADS;
    _setStorageForTests(
      makeStorage({
        downloadStream: async () => Readable.from(Buffer.from('MP3_BYTES')),
      }),
    );
    const { pool } = makePool([
      () => ({
        rows: [{ filename: 'a.mp3', mime_type: 'audio/mpeg', size_bytes: 9 }],
      }),
    ]);
    const app = makeApp((r) => mountPreviewRoutes(r, pool), pool);
    const res = await request(app).get('/api/projects/p1/preview/audio/a.mp3');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
    // Immutable audio cache — audio filenames are content-addressed.
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it('307 redirects to the signed URL when the flag is on', async () => {
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    const signedGetUrl = jest.fn(async () => 'https://storage.googleapis.com/audio?sig=xyz');
    _setStorageForTests(
      makeStorage({ signedGetUrl: signedGetUrl as ObjectStorage['signedGetUrl'] }),
    );
    const { pool } = makePool([
      () => ({
        rows: [{ filename: 'a.mp3', mime_type: 'audio/mpeg', size_bytes: 9 }],
      }),
    ]);
    const app = makeApp((r) => mountPreviewRoutes(r, pool), pool);
    const res = await request(app).get('/api/projects/p1/preview/audio/a.mp3').redirects(0);
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('https://storage.googleapis.com/audio?sig=xyz');
    // Signed URLs are per-request capabilities — no cache reuse.
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['cache-control']).toMatch(/private/);
    // Immutable audio cache header must NOT appear on the redirect
    // (it's for the audio bytes, not the 307).
    expect(res.headers['cache-control']).not.toMatch(/immutable/);
    // Signed with the correct project-scoped key.
    expect(signedGetUrl).toHaveBeenCalledWith('audio/p1/a.mp3');
  });

  it('falls through to stream when signedGetUrl returns null', async () => {
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    _setStorageForTests(
      makeStorage({
        signedGetUrl: (async () => null) as ObjectStorage['signedGetUrl'],
        downloadStream: (async () =>
          Readable.from(Buffer.from('MP3_BYTES'))) as ObjectStorage['downloadStream'],
      }),
    );
    const { pool } = makePool([
      () => ({
        rows: [{ filename: 'a.mp3', mime_type: 'audio/mpeg', size_bytes: 9 }],
      }),
    ]);
    const app = makeApp((r) => mountPreviewRoutes(r, pool), pool);
    const res = await request(app).get('/api/projects/p1/preview/audio/a.mp3').redirects(0);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
  });

  it('degrades to stream when signedGetUrl throws', async () => {
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    _setStorageForTests(
      makeStorage({
        signedGetUrl: (async () => {
          throw new Error('signBlob permission denied');
        }) as ObjectStorage['signedGetUrl'],
        downloadStream: (async () =>
          Readable.from(Buffer.from('MP3_BYTES'))) as ObjectStorage['downloadStream'],
      }),
    );
    const { pool } = makePool([
      () => ({
        rows: [{ filename: 'a.mp3', mime_type: 'audio/mpeg', size_bytes: 9 }],
      }),
    ]);
    const app = makeApp((r) => mountPreviewRoutes(r, pool), pool);
    const res = await request(app).get('/api/projects/p1/preview/audio/a.mp3').redirects(0);
    // NOT a 500 — degraded to the streaming flow.
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
  });

  it('404s (via the streaming path) when the audio file is missing entirely', async () => {
    // Same behaviour before + after this slice: the audio_files row
    // exists but the storage object doesn't (rare, but possible after
    // a delete race). The stream throws, and we surface a 404.
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    _setStorageForTests(
      makeStorage({
        signedGetUrl: (async () => null) as ObjectStorage['signedGetUrl'],
        downloadStream: (async () => {
          throw new Error('Object not found: audio/p1/a.mp3');
        }) as ObjectStorage['downloadStream'],
      }),
    );
    const { pool } = makePool([
      () => ({
        rows: [{ filename: 'a.mp3', mime_type: 'audio/mpeg', size_bytes: 9 }],
      }),
    ]);
    const app = makeApp((r) => mountPreviewRoutes(r, pool), pool);
    const res = await request(app).get('/api/projects/p1/preview/audio/a.mp3').redirects(0);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:id/builds/:buildId/preview/audio/:filename — audio_files fallback signed URL', () => {
  afterEach(() => {
    delete process.env.USE_SIGNED_URL_DOWNLOADS;
    resetStorageForTests();
  });

  it('307 redirects when the flag is on and the audio_files fallback path fires', async () => {
    // Query sequence for this route on the audio_files-fallback path:
    //   [0] build existence check (route level)
    //   [1] project_builds artifact_path lookup (inside
    //       resolveBuildPreviewAudio — null artifact skips the zip)
    //   [2] audio_files lookup (finds the row)
    // Then the storage layer is asked to sign the audio URL.
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    const signedGetUrl = jest.fn(async () => 'https://storage.googleapis.com/audio?sig=abc');
    _setStorageForTests(
      makeStorage({ signedGetUrl: signedGetUrl as ObjectStorage['signedGetUrl'] }),
    );
    const { pool } = makePool([
      () => ({ rows: [{ '?column?': 1 }] }), // build exists
      () => ({ rows: [{ artifact_path: null, status: 'completed' }] }), // no zip cache
      () => ({
        rows: [{ filename: 'a.mp3', mime_type: 'audio/mpeg', size_bytes: 9 }],
      }),
    ]);
    const app = makeApp((r) => mountBuildRoutes(r, pool), pool);
    const res = await request(app)
      .get('/api/projects/p1/builds/b1/preview/audio/a.mp3')
      .redirects(0);
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('https://storage.googleapis.com/audio?sig=abc');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['cache-control']).toMatch(/private/);
    expect(signedGetUrl).toHaveBeenCalledWith('audio/p1/a.mp3');
  });

  it('degrades to stream on signedGetUrl throw', async () => {
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    _setStorageForTests(
      makeStorage({
        signedGetUrl: (async () => {
          throw new Error('signBlob permission denied');
        }) as ObjectStorage['signedGetUrl'],
        downloadStream: (async () =>
          Readable.from(Buffer.from('MP3_BYTES'))) as ObjectStorage['downloadStream'],
      }),
    );
    const { pool } = makePool([
      () => ({ rows: [{ '?column?': 1 }] }),
      () => ({ rows: [{ artifact_path: null, status: 'completed' }] }),
      () => ({
        rows: [{ filename: 'a.mp3', mime_type: 'audio/mpeg', size_bytes: 9 }],
      }),
    ]);
    const app = makeApp((r) => mountBuildRoutes(r, pool), pool);
    const res = await request(app)
      .get('/api/projects/p1/builds/b1/preview/audio/a.mp3')
      .redirects(0);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
  });
});
