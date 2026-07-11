// Heavy-test ladder for the version-history routes. The scary
// failure mode is silent data loss on restore — if we delete
// node_metadata then a partial INSERT failure leaves the user
// with NO metadata. Pin the transactional path, the auto-
// snapshot-before-restore safety net, and the collab-room
// invalidation hook.

import { jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';

// Mock collab-server before importing the module under test.
// jest.spyOn can't intercept an ESM namespace (which is read-only),
// so we replace the module at resolve-time. This mirrors the
// pattern in src/__tests__/sentry.test.ts.
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

// Import after the mock is registered so the route picks up the
// mocked functions.
const { mountSnapshotRoutes } = await import('../projects-snapshots.js');

interface QueryCall {
  text: string;
  params?: unknown[];
}

function makePool() {
  const calls: QueryCall[] = [];
  // Per-test handlers can override what the pool returns for a
  // particular SELECT. Default: empty.
  const poolHandlers: Array<
    (text: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number } | null
  > = [];
  const clientHandlers: Array<
    (text: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number } | null
  > = [];

  const client: PoolClient = {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const h of clientHandlers) {
        const r = h(text, params);
        if (r) return r;
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  } as unknown as PoolClient;

  const pool: Pool = {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const h of poolHandlers) {
        const r = h(text, params);
        if (r) return r;
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: jest.fn(async () => client),
  } as unknown as Pool;

  return { pool, client, calls, poolHandlers, clientHandlers };
}

function makeApp(pool: Pool, opts: { userId?: string } = {}) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    (req as unknown as { log: typeof console }).log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as typeof console;
    (req as unknown as { session: { userId?: string } }).session = {
      userId: opts.userId,
    };
    next();
  }) as RequestHandler);
  const router = Router();
  mountSnapshotRoutes(router, pool);
  app.use('/api/projects', router);
  return app;
}

const VALID_PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const VALID_SNAPSHOT_ID = '22222222-2222-2222-2222-222222222222';

describe('snapshot routes', () => {
  describe('POST /:id/snapshots', () => {
    it('captures story_graph + ink_source + node_metadata into a new row', async () => {
      const { pool, calls, poolHandlers } = makePool();
      poolHandlers.push((text) => {
        if (text.includes('FROM project_stories ps')) {
          return {
            rows: [
              {
                story_graph: { nodes: { a: 1 } },
                ink_source: '== a ==',
                node_metadata: { a: { transcript: 'override' } },
              },
            ],
          };
        }
        if (text.includes('INSERT INTO project_snapshots')) {
          return {
            rows: [{ id: 'new-id', created_at: '2026-01-01T00:00:00Z' }],
          };
        }
        return null;
      });
      const res = await request(makeApp(pool, { userId: 'user-1' }))
        .post(`/api/projects/${VALID_PROJECT_ID}/snapshots`)
        .send({ label: 'My checkpoint' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe('new-id');
      const insert = calls.find((c) => c.text.includes('INSERT INTO project_snapshots'));
      expect(insert).toBeDefined();
      expect(insert!.params).toEqual([
        VALID_PROJECT_ID,
        'user-1',
        'My checkpoint',
        'manual',
        { nodes: { a: 1 } },
        '== a ==',
        { a: { transcript: 'override' } },
      ]);
    });

    it('defaults the label when none is provided', async () => {
      const { pool, calls, poolHandlers } = makePool();
      poolHandlers.push((text) => {
        if (text.includes('FROM project_stories ps')) {
          return { rows: [{ story_graph: {}, ink_source: null, node_metadata: {} }] };
        }
        if (text.includes('INSERT INTO project_snapshots')) {
          return { rows: [{ id: 'x', created_at: 'now' }] };
        }
        return null;
      });
      await request(makeApp(pool)).post(`/api/projects/${VALID_PROJECT_ID}/snapshots`).send({});
      const insert = calls.find((c) => c.text.includes('INSERT INTO project_snapshots'));
      expect((insert!.params as unknown[])[2]).toBe('Manual snapshot');
    });

    it('400s when there is no story to snapshot', async () => {
      const { pool, poolHandlers } = makePool();
      poolHandlers.push((text) => {
        if (text.includes('FROM project_stories ps')) {
          return { rows: [] };
        }
        return null;
      });
      const res = await request(makeApp(pool))
        .post(`/api/projects/${VALID_PROJECT_ID}/snapshots`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /:id/snapshots/:snapshotId/restore', () => {
    it('captures a `Before restore` auto snapshot, writes the row, replaces metadata, and invalidates the collab room', async () => {
      const { pool, client, calls, poolHandlers, clientHandlers } = makePool();

      // Capture-snapshot pre-restore reads project_stories (via pool)
      // and the snapshot lookup happens on the client. Insert returns
      // a fresh id.
      poolHandlers.push((text) => {
        if (text.includes('FROM project_stories ps')) {
          return {
            rows: [{ story_graph: { nodes: {} }, ink_source: 'pre', node_metadata: {} }],
          };
        }
        if (text.includes('INSERT INTO project_snapshots')) {
          return { rows: [{ id: 'pre-id', created_at: 'now' }] };
        }
        return null;
      });

      clientHandlers.push((text) => {
        if (text.includes('SELECT story_graph, ink_source, node_metadata')) {
          return {
            rows: [
              {
                story_graph: { nodes: { restored: 1 } },
                ink_source: 'restored',
                node_metadata: { restored: { transcript: 'v' } },
              },
            ],
          };
        }
        return null;
      });

      mockInvalidateRoom.mockClear();

      const res = await request(makeApp(pool, { userId: 'u' })).post(
        `/api/projects/${VALID_PROJECT_ID}/snapshots/${VALID_SNAPSHOT_ID}/restore`,
      );
      expect(res.status).toBe(200);

      // Must capture a `Before restore` snapshot first.
      const autoSnap = calls.find(
        (c) =>
          c.text.includes('INSERT INTO project_snapshots') &&
          (c.params as unknown[])?.[2] === 'Before restore',
      );
      expect(autoSnap).toBeDefined();
      expect((autoSnap!.params as unknown[])[3]).toBe('auto');

      // Must use a transaction.
      expect(calls.some((c) => c.text === 'BEGIN')).toBe(true);
      expect(calls.some((c) => c.text === 'COMMIT')).toBe(true);

      // Must replace story_graph + ink_source.
      expect(
        calls.some(
          (c) =>
            c.text.includes('UPDATE project_stories') &&
            c.text.includes('story_graph = $2') &&
            c.text.includes('ink_source = $3'),
        ),
      ).toBe(true);

      // Must DELETE metadata before re-inserting.
      expect(calls.some((c) => c.text === 'DELETE FROM node_metadata WHERE project_id = $1')).toBe(
        true,
      );
      expect(calls.some((c) => c.text.includes('INSERT INTO node_metadata'))).toBe(true);

      expect(mockInvalidateRoom).toHaveBeenCalledWith(VALID_PROJECT_ID);
      expect(client.release).toHaveBeenCalled();
    });

    it('404s when the snapshot does not belong to the project', async () => {
      const { pool, client } = makePool();
      // client.query default returns empty rows → snapshot lookup misses
      const res = await request(makeApp(pool)).post(
        `/api/projects/${VALID_PROJECT_ID}/snapshots/${VALID_SNAPSHOT_ID}/restore`,
      );
      expect(res.status).toBe(404);
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe('DELETE /:id/snapshots/:snapshotId', () => {
    it('returns 404 when nothing was deleted', async () => {
      const { pool, poolHandlers } = makePool();
      poolHandlers.push((text) => {
        if (text.includes('DELETE FROM project_snapshots')) {
          return { rows: [], rowCount: 0 };
        }
        return null;
      });
      const res = await request(makeApp(pool)).delete(
        `/api/projects/${VALID_PROJECT_ID}/snapshots/${VALID_SNAPSHOT_ID}`,
      );
      expect(res.status).toBe(404);
    });

    it('returns success when a row was deleted', async () => {
      const { pool, poolHandlers } = makePool();
      poolHandlers.push((text) => {
        if (text.includes('DELETE FROM project_snapshots')) {
          return { rows: [], rowCount: 1 };
        }
        return null;
      });
      const res = await request(makeApp(pool)).delete(
        `/api/projects/${VALID_PROJECT_ID}/snapshots/${VALID_SNAPSHOT_ID}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
