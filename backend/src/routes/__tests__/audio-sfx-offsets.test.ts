import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { createAudioRouter, parseOffsetMs } from '../audio.js';

// When a node's sound effect plays. The player follows `offset_ms`; these
// cover the API that sets it, and the reassign path that used to rebuild
// the row without it (swapping in a new take would have silently moved
// every effect back to the start of the passage).

const PROJECT = '11111111-1111-4111-8111-111111111111';
const FILE_A = '22222222-2222-4222-8222-222222222222';
const FILE_B = '33333333-3333-4333-8333-333333333333';

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

function makeApp(query: Query, connectQuery?: Query) {
  const pool = {
    query: jest.fn(query),
    connect: jest.fn(async () => ({
      query: jest.fn(connectQuery ?? query),
      release: () => undefined,
    })),
  } as unknown as Pool;
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
  app.use('/api/projects/:id/audio', createAudioRouter(pool));
  return { app, pool };
}

describe('parseOffsetMs', () => {
  it('treats missing and null as "at the start"', () => {
    expect(parseOffsetMs(undefined)).toBeNull();
    expect(parseOffsetMs(null)).toBeNull();
  });

  it('accepts whole milliseconds within an hour', () => {
    expect(parseOffsetMs(0)).toBe(0);
    expect(parseOffsetMs(2500)).toBe(2500);
    expect(parseOffsetMs(3_600_000)).toBe(3_600_000);
  });

  it('rejects anything else', () => {
    for (const bad of [-1, 1.5, '2500', 3_600_001, Number.NaN, {}]) {
      expect(typeof parseOffsetMs(bad)).toBe('symbol');
    }
  });
});

describe('GET /assignments', () => {
  it('reports each sound effect’s offset alongside the list', async () => {
    const { app } = makeApp(async () => ({
      rows: [
        { node_id: 'a', audio_type: 'sfx', audio_file_id: FILE_A, offset_ms: 1200 },
        { node_id: 'a', audio_type: 'sfx', audio_file_id: FILE_B, offset_ms: null },
        { node_id: 'a', audio_type: 'ambience', audio_file_id: FILE_B, offset_ms: null },
      ],
    }));
    const res = await request(app).get(`/api/projects/${PROJECT}/audio/assignments`);
    expect(res.status).toBe(200);
    expect(res.body.assignments.a).toEqual({
      sfx: [FILE_A, FILE_B],
      sfxOffsets: { [FILE_A]: 1200 },
      ambience: FILE_B,
    });
  });
});

describe('POST /assignments', () => {
  it('stores an sfx offset', async () => {
    const calls: unknown[][] = [];
    const { app } = makeApp(async (sql, params) => {
      calls.push([sql, params]);
      return { rows: sql.includes('INSERT') ? [{ id: 'x' }] : [] };
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'sfx', audioFileId: FILE_A, offsetMs: 1500 });
    expect(res.status).toBe(201);
    const insert = calls.find(([sql]) => String(sql).includes('INSERT'))!;
    expect(insert[1]).toEqual([PROJECT, 'a', 'sfx', FILE_A, 1500, true]);
  });

  // Re-posting an attached effect: an explicit null means "at the start",
  // leaving offsetMs out means "leave the timing alone".
  it('tells an explicit null apart from a missing offset', async () => {
    const inserts: unknown[][] = [];
    const { app } = makeApp(async (sql, params) => {
      if (sql.includes('INSERT')) inserts.push(params ?? []);
      return { rows: sql.includes('INSERT') ? [{}] : [] };
    });
    await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'sfx', audioFileId: FILE_A, offsetMs: null });
    await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'sfx', audioFileId: FILE_A });
    expect(inserts[0].slice(4)).toEqual([null, true]);
    expect(inserts[1].slice(4)).toEqual([null, false]);
  });

  // Two attaches to one slot must not both see it empty: the check, clear
  // and fill run in one transaction under a lock on that slot.
  it('serializes a single-slot attach under a per-slot lock', async () => {
    const sqls: string[] = [];
    const { app } = makeApp(async (sql) => {
      sqls.push(sql);
      return { rows: sql.includes('INSERT') ? [{}] : [] };
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'voiceover', audioFileId: FILE_A, expectEmpty: true });
    expect(res.status).toBe(201);
    const at = (needle: string) => sqls.findIndex((q) => q.includes(needle));
    expect(at('BEGIN')).toBeLessThan(at('pg_advisory_xact_lock'));
    expect(at('pg_advisory_xact_lock')).toBeLessThan(at('SELECT 1 FROM node_audio_assignments'));
    expect(at('SELECT 1 FROM node_audio_assignments')).toBeLessThan(at('DELETE'));
    expect(at('INSERT')).toBeLessThan(at('COMMIT'));
  });

  it('rejects an offset on a slot that has no timing', async () => {
    const { app } = makeApp(async () => ({ rows: [] }));
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'ambience', audioFileId: FILE_A, offsetMs: 1500 });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed offset', async () => {
    const { app } = makeApp(async () => ({ rows: [] }));
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'sfx', audioFileId: FILE_A, offsetMs: '1.5s' });
    expect(res.status).toBe(400);
  });
});

describe('POST /assignments with expectEmpty', () => {
  it('refuses to replace a take a peer attached in the meantime', async () => {
    const calls: string[] = [];
    const { app } = makeApp(async (sql) => {
      calls.push(sql);
      return { rows: sql.includes('SELECT 1') ? [{}] : [] };
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'voiceover', audioFileId: FILE_A, expectEmpty: true });
    expect(res.status).toBe(409);
    expect(calls.some((sql) => sql.includes('DELETE'))).toBe(false);
  });

  it('attaches when the slot really is empty', async () => {
    const { app } = makeApp(async (sql) => ({ rows: sql.includes('INSERT') ? [{}] : [] }));
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'voiceover', audioFileId: FILE_A, expectEmpty: true });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /assignments/:nodeId/sfx/:audioFileId', () => {
  it('sets the offset', async () => {
    const calls: unknown[][] = [];
    const { app } = makeApp(async (sql, params) => {
      calls.push([sql, params]);
      return { rows: sql.includes('UPDATE node_audio_assignments') ? [{ offset_ms: 900 }] : [] };
    });
    const res = await request(app)
      .patch(`/api/projects/${PROJECT}/audio/assignments/a/sfx/${FILE_A}`)
      .send({ offsetMs: 900 });
    expect(res.status).toBe(200);
    expect(calls[0][1]).toEqual([PROJECT, 'a', FILE_A, 900]);
  });

  it('clears it back to the start with null', async () => {
    const calls: unknown[][] = [];
    const { app } = makeApp(async (sql, params) => {
      calls.push([sql, params]);
      return { rows: [{}] };
    });
    const res = await request(app)
      .patch(`/api/projects/${PROJECT}/audio/assignments/a/sfx/${FILE_A}`)
      .send({ offsetMs: null });
    expect(res.status).toBe(200);
    expect(calls[0][1]).toEqual([PROJECT, 'a', FILE_A, null]);
  });

  it('requires offsetMs so an empty body can’t silently clear it', async () => {
    const { app, pool } = makeApp(async () => ({ rows: [] }));
    const res = await request(app)
      .patch(`/api/projects/${PROJECT}/audio/assignments/a/sfx/${FILE_A}`)
      .send({});
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('404s when that effect isn’t on the node', async () => {
    const { app } = makeApp(async () => ({ rows: [] }));
    const res = await request(app)
      .patch(`/api/projects/${PROJECT}/audio/assignments/a/sfx/${FILE_A}`)
      .send({ offsetMs: 100 });
    expect(res.status).toBe(404);
  });

  it('400s on a file id that isn’t a UUID', async () => {
    const { app } = makeApp(async () => ({ rows: [] }));
    const res = await request(app)
      .patch(`/api/projects/${PROJECT}/audio/assignments/a/sfx/not-a-uuid`)
      .send({ offsetMs: 100 });
    expect(res.status).toBe(400);
  });
});

describe('POST /assignments/bulk-reassign', () => {
  it('carries a sound effect’s offset over to the new take', async () => {
    const calls: unknown[][] = [];
    const { app } = makeApp(
      async () => ({ rows: [] }),
      async (sql, params) => {
        calls.push([sql, params]);
        if (sql.includes('SELECT id FROM audio_files')) return { rows: [{ id: FILE_B }] };
        if (sql.includes('DELETE FROM node_audio_assignments')) {
          return { rows: [{ id: 'row', offset_ms: 1750 }] };
        }
        if (sql.includes('INSERT INTO node_audio_assignments')) return { rows: [{ id: 'new' }] };
        return { rows: [] };
      },
    );
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments/bulk-reassign`)
      .send({ ops: [{ nodeId: 'a', audioType: 'sfx', fromFileId: FILE_A, toFileId: FILE_B }] });
    expect(res.status).toBe(200);
    const insert = calls.find(([sql]) =>
      String(sql).includes('INSERT INTO node_audio_assignments'),
    )!;
    expect(insert[1]).toEqual([PROJECT, 'a', 'sfx', FILE_B, 1750]);
  });

  // The node already has the target (it had both files, or a peer just
  // attached it). "Swap everywhere" must still succeed there: the target
  // keeps its own timing if it has one, otherwise takes the source's.
  it('merges into a target that’s already attached, keeping a timing', async () => {
    const calls: [string, unknown[]][] = [];
    const { app } = makeApp(
      async () => ({ rows: [] }),
      async (sql, params = []) => {
        calls.push([sql, params]);
        if (sql.includes('SELECT id FROM audio_files')) return { rows: [{ id: FILE_B }] };
        if (sql.includes('DELETE FROM node_audio_assignments')) {
          return { rows: [{ id: 'row', offset_ms: 1750 }] };
        }
        return { rows: [] };
      },
    );
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments/bulk-reassign`)
      .send({ ops: [{ nodeId: 'a', audioType: 'sfx', fromFileId: FILE_A, toFileId: FILE_B }] });
    expect(res.status).toBe(200);
    expect(res.body.swapped).toBe(1);
    const merge = calls.find(([sql]) => sql.includes('COALESCE(offset_ms, $5)'));
    expect(merge?.[1]).toEqual([PROJECT, 'a', 'sfx', FILE_B, 1750]);
    expect(calls.map(([sql]) => sql)).toContain('COMMIT');
  });
});
