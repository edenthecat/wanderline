import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import type { Pool } from 'pg';
import { mountBuildRoutes } from '../projects-builds.js';
import {
  resetStorageForTests,
  _setStorageForTests,
  type ObjectStorage,
} from '../../services/storage.js';

// signed-URL redirect behaviour for
// GET /api/projects/:id/builds/:buildId/download.
//
// Branches worth locking in (matching the ObjectStorage.signedGetUrl
// contract in services/storage.ts):
//   1. Flag off → existing stream-through-Cloud-Run behaviour.
//   2. Flag on + backend has a signed URL → 307 to the signed URL,
//      Cache-Control: no-store, private on the redirect response.
//   3. Flag on + backend returns null (LocalStorage: signing not
//      supported) → falls through to the streaming path, which then
//      reports 410 if the artifact is actually gone.
//   4. Flag on + backend throws (signing outage: auth, IAM, network)
//      → warn logged with buildId + key, degrades to streaming.
//   5. Flag on + artifact_path is a legacy absolute path →
//      isStorageKey() rejects it, signedGetUrl is never called.
//
// Env var USE_SIGNED_URL_DOWNLOADS is read live via useSignedUrlDownloads()
// (function, not const) so tests can flip it between cases without a
// module reload.

// Small wrapper so tests can spy on req.log.warn to lock in the
// contract that signing failures always emit a triage-friendly warn.
function makeApp(pool: Pool, warnSpy?: jest.Mock) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof console }).log = {
      info: () => undefined,
      warn: warnSpy ?? (() => undefined),
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

// Minimal SELECT row that satisfies the download handler.
function buildRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'b1',
    project_id: 'p1',
    project_name: 'Test Story',
    build_number: 3,
    status: 'completed',
    artifact_path: 'builds/b1.zip',
    deleted_at: null,
    ...overrides,
  };
}

// Return a stubbed ObjectStorage that only implements the methods the
// download handler actually calls. Anything else throws so accidental
// callers surface loudly instead of silently returning undefined.
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

describe('GET /api/projects/:id/builds/:buildId/download — signed-URL redirects', () => {
  afterEach(() => {
    delete process.env.USE_SIGNED_URL_DOWNLOADS;
    resetStorageForTests();
  });

  it('streams the zip when USE_SIGNED_URL_DOWNLOADS is unset (backwards compat)', async () => {
    delete process.env.USE_SIGNED_URL_DOWNLOADS;
    _setStorageForTests(
      makeStorage({
        downloadStream: async () => Readable.from(Buffer.from('ZIP_BYTES')),
      }),
    );
    const { pool } = makePool([() => ({ rows: [buildRow()] })]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/download');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="test_story_build3\.zip"/,
    );
  });

  it('307 redirects to the signed URL when the flag is on and the backend supports it', async () => {
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    const signedGetUrl = jest.fn(async () => 'https://storage.googleapis.com/signed?sig=abc');
    _setStorageForTests(
      makeStorage({ signedGetUrl: signedGetUrl as ObjectStorage['signedGetUrl'] }),
    );
    const { pool } = makePool([() => ({ rows: [buildRow()] })]);
    const res = await request(makeApp(pool))
      .get('/api/projects/p1/builds/b1/download')
      .redirects(0);
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('https://storage.googleapis.com/signed?sig=abc');
    // Cache-Control must lock every cache layer — a shared proxy that
    // reused this 307 would hand user A's signed URL to user B for up
    // to the TTL. no-store + private slam both.
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['cache-control']).toMatch(/private/);
    // No zip bytes were streamed — signed URL takes the whole flow.
    expect(res.headers['content-type']).not.toMatch(/application\/zip/);
    // Called with exactly one arg — the artifact key. If a future
    // regression passes an explicit ttlSeconds argument, tighten this
    // assertion (or add a length check) so nobody quietly ships a
    // longer-than-default URL.
    expect(signedGetUrl).toHaveBeenCalledTimes(1);
    expect(signedGetUrl.mock.calls[0]).toEqual(['builds/b1.zip']);
  });

  it('falls through to 410 when signedGetUrl returns null (backend does not support signing)', async () => {
    // A null return from signedGetUrl always means "the backend
    // structurally doesn't support signing" — the LocalStorage dev
    // path is the canonical case. The route falls through to the
    // streaming code path, which then 410s if the artifact is truly
    // gone from storage (simulated by the downloadStream throw).
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    _setStorageForTests(
      makeStorage({
        signedGetUrl: (async () => null) as ObjectStorage['signedGetUrl'],
        downloadStream: (async () => {
          throw new Error('Object not found: builds/b1.zip');
        }) as ObjectStorage['downloadStream'],
      }),
    );
    const { pool } = makePool([() => ({ rows: [buildRow()] })]);
    const res = await request(makeApp(pool))
      .get('/api/projects/p1/builds/b1/download')
      .redirects(0);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Build artifact expired or deleted' });
  });

  it('degrades to the stream path when signedGetUrl throws (auth / network) and emits a warn', async () => {
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    _setStorageForTests(
      makeStorage({
        signedGetUrl: (async () => {
          throw new Error('signBlob permission denied');
        }) as ObjectStorage['signedGetUrl'],
        // Streaming still works — clients get bytes rather than a 500.
        downloadStream: (async () =>
          Readable.from(Buffer.from('ZIP_BYTES'))) as ObjectStorage['downloadStream'],
      }),
    );
    const warnSpy = jest.fn();
    const { pool } = makePool([() => ({ rows: [buildRow()] })]);
    const res = await request(makeApp(pool, warnSpy))
      .get('/api/projects/p1/builds/b1/download')
      .redirects(0);
    // Should NOT be a 500 — degraded to the existing stream flow.
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    // Warn must fire so ops can see signing is broken even though the
    // stream succeeds. Silencing the catch (e.g. `catch {}`) would
    // hide GCS auth failures.
    expect(warnSpy).toHaveBeenCalled();
    // First arg is the log context object; assert both buildId AND key
    // are present so triage doesn't need a DB round-trip.
    const [ctx, msg] = warnSpy.mock.calls[0];
    expect(ctx).toMatchObject({ buildId: 'b1', key: 'builds/b1.zip' });
    expect(msg).toMatch(/signedGetUrl/);
  });

  it('does not attempt to sign a URL for a legacy absolute artifact path', async () => {
    // Pre-storage-abstraction builds carry an absolute /tmp path in
    // artifact_path. isStorageKey() rejects those, so the signed-URL
    // fast path must be skipped and we fall through to the legacy
    // existsSync branch.
    process.env.USE_SIGNED_URL_DOWNLOADS = 'true';
    const signedGetUrl = jest.fn(async () => 'https://SHOULD_NOT_BE_CALLED');
    _setStorageForTests(
      makeStorage({
        signedGetUrl: signedGetUrl as ObjectStorage['signedGetUrl'],
      }),
    );
    const { pool } = makePool([
      () => ({
        rows: [buildRow({ artifact_path: '/tmp/wanderline-builds/b1.zip' })],
      }),
    ]);
    const res = await request(makeApp(pool))
      .get('/api/projects/p1/builds/b1/download')
      .redirects(0);
    // Legacy path missing on disk → 410. The important assertion is
    // that signedGetUrl was never called for a non-storage-key value.
    expect(res.status).toBe(410);
    expect(signedGetUrl).not.toHaveBeenCalled();
  });
});
