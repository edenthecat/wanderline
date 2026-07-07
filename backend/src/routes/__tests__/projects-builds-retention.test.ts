import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { mountBuildRoutes } from '../projects-builds.js';

// route tests for pinning + soft-delete.
//
// The pin toggle + soft-delete branches of projects-builds.ts are new
// user-facing surface, so exercise them at the HTTP layer with a
// mocked pool. The reconciliation sweep itself lives in
// build-service.ts and is unit-tested there.

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

// Minimal row that formatBuild is happy with. All numeric fields as
// nulls to keep the fixture short — the retention path only cares
// about status, pinned, and deleted_at.
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    project_id: 'p1',
    build_number: 1,
    status: 'completed',
    progress: 100,
    message: null,
    error: null,
    label: null,
    total_size_bytes: null,
    audio_size_bytes: null,
    code_size_bytes: null,
    audio_file_count: null,
    node_count: null,
    artifact_path: 'builds/b1.zip',
    created_at: '2026-05-23T00:00:00.000Z',
    completed_at: '2026-05-23T00:01:00.000Z',
    created_by: null,
    pinned: false,
    deleted_at: null,
    ...overrides,
  };
}

describe('POST /api/projects/:id/builds/:buildId/pin', () => {
  it('toggles an unpinned completed build to pinned when body is omitted', async () => {
    const { pool, query } = makePool([(_sql, _params) => ({ rows: [row({ pinned: true })] })]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds/b1/pin');
    expect(res.status).toBe(200);
    expect(res.body.build.pinned).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE project_builds/);
    expect(sql).toMatch(/pinned\s*=\s*NOT pinned/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/status IN\s*\(\s*'completed',\s*'failed'\s*\)/);
    // Guard against buildId/projectId swap regressions (order matters).
    expect(params).toEqual(['b1', 'p1']);
  });

  it('toggles a pinned build back to unpinned when body is omitted', async () => {
    const { pool, query } = makePool([(_sql) => ({ rows: [row({ pinned: false })] })]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds/b1/pin');
    expect(res.status).toBe(200);
    expect(res.body.build.pinned).toBe(false);
    // Same param-order guard as above.
    expect(query.mock.calls[0][1]).toEqual(['b1', 'p1']);
  });

  it('idempotently sets pinned=true via body — safe on double-click / retry', async () => {
    const { pool, query } = makePool([(_sql) => ({ rows: [row({ pinned: true })] })]);
    const res = await request(makeApp(pool))
      .post('/api/projects/p1/builds/b1/pin')
      .send({ pinned: true });
    expect(res.status).toBe(200);
    expect(res.body.build.pinned).toBe(true);
    const [sql, params] = query.mock.calls[0];
    // Body-driven path uses parameterised SET, NOT the toggle form.
    expect(sql).toMatch(/SET pinned = \$3/);
    expect(sql).not.toMatch(/NOT pinned/);
    expect(params).toEqual(['b1', 'p1', true]);
  });

  it('idempotently sets pinned=false via body', async () => {
    const { pool, query } = makePool([(_sql) => ({ rows: [row({ pinned: false })] })]);
    const res = await request(makeApp(pool))
      .post('/api/projects/p1/builds/b1/pin')
      .send({ pinned: false });
    expect(res.status).toBe(200);
    expect(res.body.build.pinned).toBe(false);
    expect(query.mock.calls[0][1]).toEqual(['b1', 'p1', false]);
  });

  it('rejects non-boolean pinned in body with 400', async () => {
    // No pool query should fire when the body is rejected up-front.
    const { pool, query } = makePool([]);
    const res = await request(makeApp(pool))
      .post('/api/projects/p1/builds/b1/pin')
      .send({ pinned: 'yes' });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 404 when the build does not exist', async () => {
    const { pool } = makePool([
      () => ({ rows: [] }), // UPDATE returned nothing
      () => ({ rows: [] }), // existence probe: absent
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds/b1/pin');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the build is already soft-deleted', async () => {
    const { pool } = makePool([
      () => ({ rows: [] }), // UPDATE guarded
      () => ({ rows: [{ status: 'completed', deleted_at: 't' }] }), // probe: soft-deleted
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds/b1/pin');
    expect(res.status).toBe(404);
  });

  it('returns 409 when the build is still in progress', async () => {
    const { pool } = makePool([
      () => ({ rows: [] }), // UPDATE guarded
      () => ({ rows: [{ status: 'processing', deleted_at: null }] }),
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds/b1/pin');
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/projects/:id/builds/:buildId — soft-delete', () => {
  it('soft-deletes a completed build (UPDATE, not DELETE)', async () => {
    const { pool, query } = makePool([(_sql, _params) => ({ rows: [row({ pinned: false })] })]);
    const res = await request(makeApp(pool)).delete('/api/projects/p1/builds/b1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deleted: 'b1' });
    const [sql, params] = query.mock.calls[0];
    // Must be an UPDATE — the old code did DELETE FROM.
    expect(sql).toMatch(/^\s*UPDATE project_builds/);
    // Sets deleted_at NOW() and forces pinned = FALSE (so the
    // reconciliation sweep's pinned=FALSE guard doesn't strand the row).
    expect(sql).toMatch(/deleted_at\s*=\s*NOW\(\)/);
    expect(sql).toMatch(/pinned\s*=\s*FALSE/);
    // Guarded against re-soft-deleting an already-deleted row.
    expect(sql).toMatch(/deleted_at IS NULL/);
    // Still refuses to touch in-progress rows.
    expect(sql).toMatch(/status IN\s*\(\s*'completed',\s*'failed'\s*\)/);
    // Guard against buildId/projectId swap regressions.
    expect(params).toEqual(['b1', 'p1']);
  });

  it('returns 409 when the build is still in progress', async () => {
    const { pool } = makePool([
      () => ({ rows: [] }), // UPDATE guarded
      () => ({ rows: [{ status: 'processing', deleted_at: null }] }),
    ]);
    const res = await request(makeApp(pool)).delete('/api/projects/p1/builds/b1');
    expect(res.status).toBe(409);
  });

  it('returns 404 when the build is already soft-deleted (idempotent-friendly)', async () => {
    const { pool } = makePool([
      () => ({ rows: [] }), // UPDATE guarded
      () => ({ rows: [{ status: 'completed', deleted_at: 't' }] }), // probe: soft-deleted
    ]);
    const res = await request(makeApp(pool)).delete('/api/projects/p1/builds/b1');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the build never existed', async () => {
    const { pool } = makePool([() => ({ rows: [] }), () => ({ rows: [] })]);
    const res = await request(makeApp(pool)).delete('/api/projects/p1/builds/b1');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:id/builds — hides soft-deleted', () => {
  it('scopes the list query to deleted_at IS NULL', async () => {
    const { pool, query } = makePool([() => ({ rows: [row()] })]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds');
    expect(res.status).toBe(200);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT[\s\S]*FROM project_builds/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });
});
