import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { createAudioRouter } from '../audio.js';
import {
  isChoiceAudioType,
  choiceIdFromAudioType,
  audioTypeForChoice,
} from '../../services/choice-audio.js';

// Per-choice audio addressed by the choice's own stable id (DEV-199
// stable-id rollout), encoded as audio_type = `choice:<id>` rather
// than a separate column — coexists with the older choice1/choice2
// ordinal slots. These tests cover the encoding helpers, that the
// new audioType form is accepted where choice1/choice2 already was,
// and that GET /assignments groups it into its own `choices` map.

const PROJECT = '11111111-1111-4111-8111-111111111111';
const FILE_A = '22222222-2222-4222-8222-222222222222';
const CHOICE_ID = 'c-abc-123';

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

describe('choice-audio encoding helpers', () => {
  it('round-trips a choice id through audioTypeForChoice/choiceIdFromAudioType', () => {
    const audioType = audioTypeForChoice(CHOICE_ID);
    expect(audioType).toBe(`choice:${CHOICE_ID}`);
    expect(isChoiceAudioType(audioType)).toBe(true);
    expect(choiceIdFromAudioType(audioType)).toBe(CHOICE_ID);
  });

  it('does not treat the ordinal slots as choice-audio-type', () => {
    expect(isChoiceAudioType('choice1')).toBe(false);
    expect(isChoiceAudioType('choice2')).toBe(false);
    expect(isChoiceAudioType('voiceover')).toBe(false);
  });
});

describe('POST /assignments with a choice:<id> audioType', () => {
  it('accepts it and inserts like any other single-value slot', async () => {
    const sqls: string[] = [];
    const { app } = makeApp(async (sql) => {
      sqls.push(sql);
      return {
        rows: sql.includes('INSERT') ? [{ audio_type: audioTypeForChoice(CHOICE_ID) }] : [],
      };
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: audioTypeForChoice(CHOICE_ID), audioFileId: FILE_A });

    expect(res.status).toBe(201);
    const insert = sqls.find((sql) => sql.includes('INSERT'))!;
    expect(insert).toContain(
      'ON CONFLICT (project_id, node_id, audio_type, audio_file_id) WHERE condition IS NULL',
    );
  });

  it('still rejects a genuinely unknown audioType', async () => {
    const { app, pool } = makeApp(async () => ({ rows: [] }));
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments`)
      .send({ nodeId: 'a', audioType: 'bogus', audioFileId: FILE_A });
    expect(res.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('GET /assignments groups choice:<id> rows under `choices`', () => {
  it('keys by the choice id, separate from choice1/choice2', async () => {
    const { app } = makeApp(async () => ({
      rows: [
        { node_id: 'a', audio_type: 'choice1', audio_file_id: FILE_A, condition: null },
        {
          node_id: 'a',
          audio_type: audioTypeForChoice(CHOICE_ID),
          audio_file_id: FILE_A,
          condition: null,
        },
      ],
    }));
    const res = await request(app).get(`/api/projects/${PROJECT}/audio/assignments`);
    expect(res.status).toBe(200);
    expect(res.body.assignments.a.choice1).toEqual([{ fileId: FILE_A }]);
    expect(res.body.assignments.a.choices).toEqual({ [CHOICE_ID]: [{ fileId: FILE_A }] });
  });

  it('keeps two different choices separate', async () => {
    const { app } = makeApp(async () => ({
      rows: [
        {
          node_id: 'a',
          audio_type: audioTypeForChoice('c1'),
          audio_file_id: FILE_A,
          condition: null,
        },
        {
          node_id: 'a',
          audio_type: audioTypeForChoice('c2'),
          audio_file_id: FILE_A,
          condition: null,
        },
      ],
    }));
    const res = await request(app).get(`/api/projects/${PROJECT}/audio/assignments`);
    expect(Object.keys(res.body.assignments.a.choices)).toEqual(['c1', 'c2']);
  });
});

describe('bulk-reassign with a choice:<id> audioType', () => {
  const FROM_FILE = '33333333-3333-4333-8333-333333333333';

  it('passes op validation and swaps the file', async () => {
    const { app } = makeApp(async (sql) => {
      if (sql.includes('SELECT id FROM audio_files')) return { rows: [{ id: FILE_A }] };
      if (sql.includes('DELETE')) return { rows: [{ id: 1, offset_ms: null, condition: null }] };
      if (sql.includes('INSERT')) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/assignments/bulk-reassign`)
      .send({
        ops: [
          {
            nodeId: 'a',
            audioType: audioTypeForChoice(CHOICE_ID),
            fromFileId: FROM_FILE,
            toFileId: FILE_A,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.swapped).toBe(1);
  });
});
