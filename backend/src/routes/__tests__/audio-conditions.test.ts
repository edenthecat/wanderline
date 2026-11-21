import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { createAudioRouter, parseCondition } from '../audio.js';

// Variable-conditioned audio: a slot (voiceover/ambience/choice1/
// choice2/sfx) can hold several candidate files instead of one, each
// gated by an optional {variable, operator, value} condition. These
// tests cover the API surface — parseCondition's validation, and how
// POST/DELETE/bulk-reassign key on (nodeId, audioType, condition)
// instead of just (nodeId, audioType).

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

describe('parseCondition', () => {
  it('treats missing and null as "the default variant"', () => {
    expect(parseCondition(undefined)).toBeNull();
    expect(parseCondition(null)).toBeNull();
  });

  it('accepts a well-formed condition for each value type', () => {
    expect(parseCondition({ variable: 'gold', operator: '>', value: 10 })).toEqual({
      variable: 'gold',
      operator: '>',
      value: 10,
    });
    expect(parseCondition({ variable: 'mood', operator: '==', value: 'angry' })).toEqual({
      variable: 'mood',
      operator: '==',
      value: 'angry',
    });
    expect(parseCondition({ variable: 'hasKey', operator: '==', value: true })).toEqual({
      variable: 'hasKey',
      operator: '==',
      value: true,
    });
  });

  it('rejects anything malformed', () => {
    for (const bad of [
      'gold > 10', // a string, not an object — this is a dropdown-built value, never typed syntax
      { operator: '>', value: 10 }, // missing variable
      { variable: '', operator: '>', value: 10 }, // empty variable name
      { variable: 'gold', value: 10 }, // missing operator
      { variable: 'gold', operator: '&&', value: 10 }, // not a comparison operator
      { variable: 'gold', operator: '>', value: { nested: true } }, // value must be string/number/boolean
      { variable: 'gold', operator: '>' }, // missing value
      [],
    ]) {
      expect(typeof parseCondition(bad)).toBe('symbol');
    }
  });
});

describe('GET /assignments', () => {
  it('lists every variant for a slot, default and conditioned alike', async () => {
    const { app } = makeApp(async () => ({
      rows: [
        { node_id: 'a', audio_type: 'voiceover', audio_file_id: FILE_A, condition: null },
        {
          node_id: 'a',
          audio_type: 'voiceover',
          audio_file_id: FILE_B,
          condition: { variable: 'mood', operator: '==', value: 'angry' },
        },
      ],
    }));
    const res = await request(app).get(`/api/projects/${PROJECT}/audio/assignments`);
    expect(res.status).toBe(200);
    expect(res.body.assignments.a.voiceover).toEqual([
      { fileId: FILE_A },
      { fileId: FILE_B, condition: { variable: 'mood', operator: '==', value: 'angry' } },
    ]);
  });
});

describe('POST /assignments with a condition', () => {
  it('rejects a malformed condition before touching the database', async () => {
    const { app, pool } = makeApp(async () => ({ rows: [] }));
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({
        nodeId: 'a',
        audioType: 'voiceover',
        audioFileId: FILE_A,
        condition: { variable: 'mood', operator: 'nope', value: 'angry' },
      });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('clears only the matching condition before inserting, not the whole slot', async () => {
    const sqls: { sql: string; params: unknown[] }[] = [];
    const { app } = makeApp(async (sql, params = []) => {
      sqls.push({ sql, params });
      return { rows: sql.includes('INSERT') ? [{}] : [] };
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({
        nodeId: 'a',
        audioType: 'voiceover',
        audioFileId: FILE_A,
        condition: { variable: 'mood', operator: '==', value: 'angry' },
      });
    expect(res.status).toBe(201);
    const del = sqls.find((c) => c.sql.includes('DELETE'))!;
    expect(del.params).toEqual([
      PROJECT,
      'a',
      'voiceover',
      JSON.stringify({ variable: 'mood', operator: '==', value: 'angry' }),
    ]);
    const insert = sqls.find((c) => c.sql.includes('INSERT'))!;
    expect(insert.sql).toContain(
      'ON CONFLICT (project_id, node_id, audio_type, audio_file_id, condition)',
    );
    expect(insert.params).toEqual([
      PROJECT,
      'a',
      'voiceover',
      FILE_A,
      null,
      false,
      JSON.stringify({ variable: 'mood', operator: '==', value: 'angry' }),
    ]);
  });

  it('uses the partial (condition IS NULL) conflict target for the default variant', async () => {
    const sqls: string[] = [];
    const { app } = makeApp(async (sql) => {
      sqls.push(sql);
      return { rows: sql.includes('INSERT') ? [{}] : [] };
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'voiceover', audioFileId: FILE_A });
    expect(res.status).toBe(201);
    const insert = sqls.find((sql) => sql.includes('INSERT'))!;
    expect(insert).toContain(
      'ON CONFLICT (project_id, node_id, audio_type, audio_file_id) WHERE condition IS NULL',
    );
  });

  it('expectEmpty checks the SAME condition, not the whole slot', async () => {
    const sqls: { sql: string; params: unknown[] }[] = [];
    const { app } = makeApp(async (sql, params = []) => {
      sqls.push({ sql, params });
      // Pretend the default variant is already filled, but this
      // condition is not — expectEmpty should only care about this one.
      return { rows: sql.includes('SELECT 1') ? [] : sql.includes('INSERT') ? [{}] : [] };
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({
        nodeId: 'a',
        audioType: 'voiceover',
        audioFileId: FILE_A,
        expectEmpty: true,
        condition: { variable: 'mood', operator: '==', value: 'angry' },
      });
    expect(res.status).toBe(201);
    const check = sqls.find((c) => c.sql.includes('SELECT 1'))!;
    expect(check.params).toEqual([
      PROJECT,
      'a',
      'voiceover',
      JSON.stringify({ variable: 'mood', operator: '==', value: 'angry' }),
    ]);
  });
});

describe('DELETE /assignments/:nodeId/:audioType with a condition', () => {
  it('targets only the matching condition when one is given in the query string', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const { app } = makeApp(async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [{ id: 'x' }] };
    });
    const res = await request(app)
      .delete(`/api/projects/${PROJECT}/audio/assignments/a/voiceover`)
      .query({ condition: JSON.stringify({ variable: 'mood', operator: '==', value: 'angry' }) });
    expect(res.status).toBe(200);
    expect(calls[0].params).toEqual([
      PROJECT,
      'a',
      'voiceover',
      JSON.stringify({ variable: 'mood', operator: '==', value: 'angry' }),
    ]);
  });

  it('targets the default (condition IS NULL) variant when none is given, unchanged from before', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const { app } = makeApp(async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [{ id: 'x' }] };
    });
    const res = await request(app).delete(`/api/projects/${PROJECT}/audio/assignments/a/voiceover`);
    expect(res.status).toBe(200);
    expect(calls[0].params).toEqual([PROJECT, 'a', 'voiceover', null]);
  });

  it('rejects malformed JSON in the condition query param', async () => {
    const { app, pool } = makeApp(async () => ({ rows: [] }));
    const res = await request(app)
      .delete(`/api/projects/${PROJECT}/audio/assignments/a/voiceover`)
      .query({ condition: '{not valid json' });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('POST /assignments/bulk-reassign carries a row condition forward', () => {
  it('passes the deleted row’s own condition into the insert, not a fixed shape', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const condition = { variable: 'scary', operator: '==', value: true };
    const { app } = makeApp(
      async () => ({ rows: [] }),
      async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT id FROM audio_files')) return { rows: [{ id: FILE_B }] };
        if (sql.includes('DELETE FROM node_audio_assignments')) {
          return { rows: [{ id: 'row', offset_ms: null, condition }] };
        }
        if (sql.includes('INSERT INTO node_audio_assignments')) return { rows: [{ id: 'new' }] };
        return { rows: [] };
      },
    );
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments/bulk-reassign`)
      .send({
        ops: [{ nodeId: 'a', audioType: 'ambience', fromFileId: FILE_A, toFileId: FILE_B }],
      });
    expect(res.status).toBe(200);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO node_audio_assignments'))!;
    expect(insert.sql).toContain(
      'ON CONFLICT (project_id, node_id, audio_type, audio_file_id, condition)',
    );
    expect(insert.params).toEqual([
      PROJECT,
      'a',
      'ambience',
      FILE_B,
      null,
      JSON.stringify(condition),
    ]);
  });

  it('uses the partial (condition IS NULL) conflict target when the deleted row had no condition', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const { app } = makeApp(
      async () => ({ rows: [] }),
      async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT id FROM audio_files')) return { rows: [{ id: FILE_B }] };
        if (sql.includes('DELETE FROM node_audio_assignments')) {
          return { rows: [{ id: 'row', offset_ms: null, condition: null }] };
        }
        if (sql.includes('INSERT INTO node_audio_assignments')) return { rows: [{ id: 'new' }] };
        return { rows: [] };
      },
    );
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments/bulk-reassign`)
      .send({
        ops: [{ nodeId: 'a', audioType: 'ambience', fromFileId: FILE_A, toFileId: FILE_B }],
      });
    expect(res.status).toBe(200);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO node_audio_assignments'))!;
    expect(insert.sql).toContain(
      'ON CONFLICT (project_id, node_id, audio_type, audio_file_id) WHERE condition IS NULL',
    );
  });
});
