import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { mountBuildRoutes } from '../projects-builds.js';
import { storyHash } from '../../services/story-hash.js';

// content-hash dedup + retention auto-cull + Idempotency-Key
// at POST /projects/:id/builds. All exercised via a mocked pool.
//
// The POST handler's query sequence (in order):
//   [0] pool.query — project + story_graph fetch
//   [1] client.query — BEGIN
//   [2] client.query — advisory lock
//   [3] client.query — idempotency lookup (only when Idempotency-Key header set)
//                      OR active-build check (when no header)
//   [4]+ subsequent branches depend on the path taken
//
// Each test declares the exact handler sequence it expects; an
// unexpected extra query throws so regressions that add a step surface
// loudly.

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
    (req as unknown as { session: { userId: string } }).session = { userId: 'u1' };
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

function completedRow(id: string, hash: string) {
  return {
    id,
    project_id: 'p1',
    build_number: 3,
    status: 'completed',
    progress: 100,
    message: 'Build complete',
    error: null,
    label: null,
    total_size_bytes: null,
    audio_size_bytes: null,
    code_size_bytes: null,
    audio_file_count: null,
    node_count: null,
    artifact_path: 'builds/x.zip',
    created_at: '2026-06-01T00:00:00.000Z',
    completed_at: '2026-06-01T00:01:00.000Z',
    created_by: 'u1',
    pinned: false,
    deleted_at: null,
    player_bundle_version: null,
    player_bundle_sri_hash: null,
    story_snapshot_hash: hash,
    attempt_count: 1,
    idempotency_key: null,
  };
}

const SAMPLE_GRAPH = { nodes: { start: { type: 'knot' } }, startNode: 'start' };
const SAMPLE_HASH = storyHash(SAMPLE_GRAPH);

const projectHit = () => ({ rows: [{ id: 'p1', story_graph: SAMPLE_GRAPH }] });
const empty = () => ({ rows: [] });
const countZero = () => ({ rows: [{ count: '0' }] });
const numberOne = () => ({ rows: [{ next: 1 }] });

describe('POST /api/projects/:id/builds — story-hash dedup + retention + idempotency', () => {
  afterEach(() => {
    delete process.env.USE_BUILD_DEDUP;
  });

  it('flag on + matching hash → 200 + X-Wanderline-Dedup + no-store Cache-Control', async () => {
    process.env.USE_BUILD_DEDUP = 'true';
    const { pool } = makePool([
      projectHit, // [0] project fetch
      empty, // [1] BEGIN
      empty, // [2] advisory lock
      empty, // [3] no active builds
      countZero, // [4] count (no cull needed)
      () => ({ rows: [completedRow('b-dedup', SAMPLE_HASH)] }), // [5] dedup HIT
      empty, // [6] COMMIT
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds').send({});
    expect(res.status).toBe(200);
    expect(res.body.build.id).toBe('b-dedup');
    expect(res.headers['x-wanderline-dedup']).toBe('story-hash-match');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['cache-control']).toMatch(/private/);
  });

  it('flag on + no matching hash → 202 + no dedup header + INSERT fires', async () => {
    process.env.USE_BUILD_DEDUP = 'true';
    const { pool } = makePool([
      projectHit, // [0]
      empty, // [1] BEGIN
      empty, // [2] advisory
      empty, // [3] no active
      countZero, // [4] count
      empty, // [5] dedup miss
      numberOne, // [6] next number
      () => ({ rows: [completedRow('b-new', SAMPLE_HASH)] }), // [7] INSERT
      empty, // [8] COMMIT
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds').send({});
    expect(res.status).toBe(202);
    expect(res.body.build.id).toBe('b-new');
    expect(res.headers['x-wanderline-dedup']).toBeUndefined();
  });

  it('flag off → skips the dedup SELECT + 202 has no dedup header', async () => {
    delete process.env.USE_BUILD_DEDUP;
    const { pool, query } = makePool([
      projectHit, // [0]
      empty, // [1] BEGIN
      empty, // [2] advisory
      empty, // [3] no active
      countZero, // [4] count
      numberOne, // [5] next number (no dedup SELECT)
      () => ({ rows: [completedRow('b-new', SAMPLE_HASH)] }), // [6] INSERT
      empty, // [7] COMMIT
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds').send({});
    expect(res.status).toBe(202);
    expect(res.headers['x-wanderline-dedup']).toBeUndefined();
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toMatch(/story_snapshot_hash\s*=/);
    }
  });

  it('flag on + active build → 409 still wins, dedup never queried', async () => {
    process.env.USE_BUILD_DEDUP = 'true';
    const { pool, query } = makePool([
      projectHit, // [0]
      empty, // [1] BEGIN
      empty, // [2] advisory
      () => ({ rows: [{ id: 'b-pending' }] }), // [3] active EXISTS
      empty, // [4] ROLLBACK
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds').send({});
    expect(res.status).toBe(409);
    expect(res.body.buildId).toBe('b-pending');
    expect(res.headers['x-wanderline-dedup']).toBeUndefined();
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toMatch(/story_snapshot_hash\s*=/);
    }
  });
});

describe('POST /api/projects/:id/builds — retention auto-cull', () => {
  it('at cap → soft-deletes oldest non-pinned + proceeds with INSERT', async () => {
    const { pool, query } = makePool([
      projectHit, // [0]
      empty, // [1] BEGIN
      empty, // [2] advisory
      empty, // [3] no active
      () => ({ rows: [{ count: '5' }] }), // [4] at cap
      () => ({ rows: [{ id: 'b-oldest' }] }), // [5] cull candidate found
      () => ({ rows: [{ id: 'b-oldest' }] }), // [6] UPDATE deleted_at with RETURNING id
      numberOne, // [7] next number
      () => ({ rows: [completedRow('b-new', SAMPLE_HASH)] }), // [8] INSERT
      empty, // [9] COMMIT
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds').send({});
    expect(res.status).toBe(202);
    expect(res.body.build.id).toBe('b-new');
    // Cull candidate SQL filters on pinned = FALSE + status in terminal.
    const [cullSql] = query.mock.calls[5];
    expect(cullSql).toMatch(/pinned\s*=\s*FALSE/);
    expect(cullSql).toMatch(/status IN\s*\(\s*'completed',\s*'failed',\s*'cancelled'\s*\)/);
    // The soft-delete UPDATE targets the cull-candidate row and
    // re-checks the invariants — a concurrent pin between SELECT
    // and UPDATE must NOT let us delete a live build.
    const [cullUpdateSql, cullUpdateParams] = query.mock.calls[6];
    expect(cullUpdateSql).toMatch(/deleted_at = NOW\(\)/);
    expect(cullUpdateSql).toMatch(/pinned\s*=\s*FALSE/);
    expect(cullUpdateSql).toMatch(/deleted_at IS NULL/);
    expect(cullUpdateSql).toMatch(/RETURNING id/);
    expect(cullUpdateParams).toEqual(['b-oldest']);
  });

  it('cull candidate gets pinned between SELECT and UPDATE → 409 (TOCTOU guard)', async () => {
    // Concurrent pin: the SELECT finds a non-pinned candidate but
    // the guarded UPDATE returns 0 rows because pinned=TRUE now.
    // Fail explicitly instead of silently soft-deleting a live build.
    const { pool } = makePool([
      projectHit, // [0]
      empty, // [1] BEGIN
      empty, // [2] advisory
      empty, // [3] no active
      () => ({ rows: [{ count: '5' }] }), // [4] at cap
      () => ({ rows: [{ id: 'b-oldest' }] }), // [5] cull candidate found
      empty, // [6] guarded UPDATE — returned 0 rows (pinned raced)
      empty, // [7] ROLLBACK
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pinned or deleted/);
  });

  it('at cap + every build pinned → 400 with "unpin one first"', async () => {
    const { pool } = makePool([
      projectHit, // [0]
      empty, // [1] BEGIN
      empty, // [2] advisory
      empty, // [3] no active
      () => ({ rows: [{ count: '5' }] }), // [4] at cap
      empty, // [5] cull candidate: none (all pinned)
      empty, // [6] ROLLBACK
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pinned/);
    expect(res.body.error).toMatch(/[Uu]npin/);
  });
});

describe('POST /api/projects/:id/builds — Idempotency-Key', () => {
  it('same key + same user + within window → 200 + X-Wanderline-Idempotent + no INSERT', async () => {
    const { pool, query } = makePool([
      projectHit, // [0]
      empty, // [1] BEGIN
      empty, // [2] advisory
      () => ({ rows: [completedRow('b-existing', SAMPLE_HASH)] }), // [3] idempotency HIT
      empty, // [4] COMMIT
    ]);
    const res = await request(makeApp(pool))
      .post('/api/projects/p1/builds')
      .set('Idempotency-Key', 'client-req-abc123')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.build.id).toBe('b-existing');
    expect(res.headers['x-wanderline-idempotent']).toBe('hit');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    // Idempotency lookup carries the 3-column scope + interval guard.
    const [idempoSql, idempoParams] = query.mock.calls[3];
    expect(idempoSql).toMatch(/idempotency_key = \$3/);
    expect(idempoSql).toMatch(/created_by = \$2/);
    expect(idempoSql).toMatch(/make_interval\(days\s*=>\s*\$4::int\)/);
    expect(idempoParams).toEqual(['p1', 'u1', 'client-req-abc123', 7]);
  });

  it('key present but no match → normal enqueue path, INSERT stamps idempotency_key', async () => {
    const { pool, query } = makePool([
      projectHit, // [0]
      empty, // [1] BEGIN
      empty, // [2] advisory
      empty, // [3] idempotency miss
      empty, // [4] no active
      countZero, // [5] count
      numberOne, // [6] next number
      () => ({ rows: [completedRow('b-new', SAMPLE_HASH)] }), // [7] INSERT
      empty, // [8] COMMIT
    ]);
    const res = await request(makeApp(pool))
      .post('/api/projects/p1/builds')
      .set('Idempotency-Key', 'client-req-xyz')
      .send({});
    expect(res.status).toBe(202);
    // INSERT includes the idempotency_key as the 5th param so a
    // later retry with the same key can find this row.
    const [insertSql, insertParams] = query.mock.calls[7];
    expect(insertSql).toMatch(/idempotency_key/);
    expect(insertParams).toContain('client-req-xyz');
  });

  it('whitespace-only key → 400 upfront, no txn opened', async () => {
    const { pool, query } = makePool([]);
    const res = await request(makeApp(pool))
      .post('/api/projects/p1/builds')
      .set('Idempotency-Key', '   ')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/);
    expect(query).not.toHaveBeenCalled();
  });

  it('overlong key (>128 chars) → 400 upfront', async () => {
    const { pool, query } = makePool([]);
    const res = await request(makeApp(pool))
      .post('/api/projects/p1/builds')
      .set('Idempotency-Key', 'x'.repeat(129))
      .send({});
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/projects/:id/builds/:buildId/cancel', () => {
  it('cancels a processing build → 200 + status="cancelled"', async () => {
    const { pool, query } = makePool([
      () => ({
        rows: [{ ...completedRow('b1', SAMPLE_HASH), status: 'cancelled' }],
      }),
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds/b1/cancel');
    expect(res.status).toBe(200);
    expect(res.body.build.status).toBe('cancelled');
    // UPDATE scoped correctly to non-terminal + not-deleted rows.
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(sql).toMatch(/status IN\s*\(\s*'pending',\s*'processing'\s*\)/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(params).toEqual(['b1', 'p1']);
  });

  it('terminal-state build → 409', async () => {
    const { pool } = makePool([
      () => ({ rows: [] }), // UPDATE guarded
      () => ({ rows: [{ status: 'completed', deleted_at: null }] }), // existence probe
    ]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds/b1/cancel');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/completed/);
  });

  it('missing / soft-deleted build → 404', async () => {
    const { pool } = makePool([() => ({ rows: [] }), () => ({ rows: [] })]);
    const res = await request(makeApp(pool)).post('/api/projects/p1/builds/b1/cancel');
    expect(res.status).toBe(404);
  });
});
