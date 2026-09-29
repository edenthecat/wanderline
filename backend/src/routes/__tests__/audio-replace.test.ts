import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ObjectStorage } from '../../services/storage.js';

// Uploads land on disk before the route runs; keep them out of the shared
// uploads directory. Set before the router (and config) is imported.
const uploadDir = mkdtempSync(join(tmpdir(), 'wanderline-replace-'));
process.env.UPLOAD_DIR = uploadDir;
const { createAudioRouter } = await import('../audio.js');
const { _setStorageForTests, resetStorageForTests } = await import('../../services/storage.js');

// Uploading a new take over an existing file. The file keeps its id, so
// every node it's attached to (and each effect's timing) picks the new
// take up with no reassigning; it's stored under a new name, so nothing
// downstream can serve the old one from a cache.

const PROJECT = '11111111-1111-4111-8111-111111111111';
const AUDIO = '22222222-2222-4222-8222-222222222222';

function makeStorage(overrides: Partial<ObjectStorage> = {}) {
  return {
    uploadFile: jest.fn(async () => undefined),
    downloadStream: jest.fn(async () => {
      throw new Error('unused');
    }),
    delete: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
    size: jest.fn(async () => 1),
    signedGetUrl: jest.fn(async () => null),
    ...overrides,
  } as unknown as { [K in keyof ObjectStorage]: jest.Mock };
}

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

function makeApp(query: Query) {
  const q = jest.fn(query);
  // The replace runs its lock + update on a client; same script.
  const pool = {
    query: q,
    connect: jest.fn(async () => ({ query: q, release: () => undefined })),
  } as unknown as Pool & { query: jest.Mock };
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

const url = `/api/projects/${PROJECT}/audio/${AUDIO}/replace`;
const take = () => Buffer.from('ID3fake-mp3-bytes');

afterEach(() => resetStorageForTests());
afterAll(() => rmSync(uploadDir, { recursive: true, force: true }));

/** The route's queries, scripted: the file exists, the locked read
 * returns the old filename, and (unless told otherwise) no build is
 * running. `vanished`: deleted between the upload starting and the lock. */
function script(opts: { exists?: boolean; vanished?: boolean; buildRunning?: boolean } = {}) {
  const { exists = true, vanished = false, buildRunning = false } = opts;
  return async (sql: string) => {
    if (sql.includes('SELECT 1 FROM audio_files')) return { rows: exists ? [{}] : [] };
    if (sql.includes('FOR UPDATE')) {
      return { rows: vanished ? [] : [{ filename: 'old-take.mp3' }] };
    }
    if (sql.includes('UPDATE audio_files')) return { rows: [{ id: AUDIO }] };
    if (sql.includes('FROM project_builds')) return { rows: buildRunning ? [{}] : [] };
    return { rows: [] };
  };
}

describe('POST /:audioId/replace', () => {
  it('stores the new take under a new name and points the same file at it', async () => {
    const storage = makeStorage();
    _setStorageForTests(storage as unknown as ObjectStorage);
    const calls: [string, unknown[]][] = [];
    const answer = script();
    const { app } = makeApp(async (sql, params = []) => {
      calls.push([sql, params]);
      return answer(sql);
    });

    const res = await request(app).post(url).attach('audio', take(), 'take-2.mp3');
    expect(res.status).toBe(200);
    expect(res.body.audioFile.id).toBe(AUDIO);

    const [key] = storage.uploadFile.mock.calls[0] as [string];
    expect(key).toMatch(new RegExp(`^audio/${PROJECT}/[0-9a-f-]+\\.mp3$`));
    expect(key).not.toContain('old-take');

    const [, updateParams] = calls.find(([sql]) => sql.includes('UPDATE audio_files'))!;
    // Same id and project; new stored name; the author's filename.
    expect(updateParams[0]).toBe(AUDIO);
    expect(updateParams[1]).toBe(PROJECT);
    expect(key.endsWith(String(updateParams[2]))).toBe(true);
    expect(updateParams[3]).toBe('take-2.mp3');

    // The old take is removed, like deleting a file does.
    expect(storage.delete).toHaveBeenCalledWith(`audio/${PROJECT}/old-take.mp3`);
    // The old name is read under a lock, in the same transaction.
    const sqls = calls.map(([sql]) => sql);
    const lock = sqls.findIndex((sql) => sql.includes('FOR UPDATE'));
    expect(sqls[lock - 1]).toBe('BEGIN');
    expect(sqls.indexOf('COMMIT')).toBeGreaterThan(
      sqls.findIndex((sql) => sql.includes('UPDATE audio_files')),
    );
    // Assignments aren't touched: they point at the id.
    expect(calls.some(([sql]) => sql.includes('node_audio_assignments'))).toBe(false);
  });

  it('404s for a file that isn’t in this project, storing nothing', async () => {
    const storage = makeStorage();
    _setStorageForTests(storage as unknown as ObjectStorage);
    const { app } = makeApp(script({ exists: false }));
    const res = await request(app).post(url).attach('audio', take(), 'take-2.mp3');
    expect(res.status).toBe(404);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it('leaves the old take alone when storage fails', async () => {
    const storage = makeStorage({
      uploadFile: jest.fn(async () => {
        throw new Error('gcs down');
      }) as never,
    });
    _setStorageForTests(storage as unknown as ObjectStorage);
    const calls: string[] = [];
    const answer = script();
    const { app } = makeApp(async (sql) => {
      calls.push(sql);
      return answer(sql);
    });
    const res = await request(app).post(url).attach('audio', take(), 'take-2.mp3');
    expect(res.status).toBe(503);
    expect(calls.some((sql) => sql.includes('UPDATE audio_files'))).toBe(false);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('cleans up the new take if the file was deleted mid-upload', async () => {
    const storage = makeStorage();
    _setStorageForTests(storage as unknown as ObjectStorage);
    const { app } = makeApp(script({ vanished: true }));
    const res = await request(app).post(url).attach('audio', take(), 'take-2.mp3');
    expect(res.status).toBe(404);
    const [newKey] = storage.uploadFile.mock.calls[0] as [string];
    expect(storage.delete).toHaveBeenCalledWith(newKey);
    expect(storage.delete).not.toHaveBeenCalledWith(`audio/${PROJECT}/old-take.mp3`);
  });

  // A running build copies audio by the filenames it already assembled;
  // deleting the old take under it would ship a build missing the clip.
  it('keeps the old take while a build is running', async () => {
    const storage = makeStorage();
    _setStorageForTests(storage as unknown as ObjectStorage);
    const { app } = makeApp(script({ buildRunning: true }));
    const res = await request(app).post(url).attach('audio', take(), 'take-2.mp3');
    expect(res.status).toBe(200);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('turns a format it won’t take into a message, not a bare 500', async () => {
    _setStorageForTests(makeStorage() as unknown as ObjectStorage);
    const { app } = makeApp(script());
    const res = await request(app)
      .post(url)
      .attach('audio', Buffer.from('x'), { filename: 'take.flac', contentType: 'audio/flac' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mp3, wav, ogg, webm/);
  });

  it('rolls back, drops the connection and keeps the old take if the update fails', async () => {
    const storage = makeStorage();
    _setStorageForTests(storage as unknown as ObjectStorage);
    const answer = script();
    const calls: string[] = [];
    const { app, pool } = makeApp(async (sql) => {
      calls.push(sql);
      if (sql.includes('UPDATE audio_files')) throw new Error('deadlock');
      return answer(sql);
    });
    const release = jest.fn();
    (pool as unknown as { connect: jest.Mock }).connect.mockImplementation(async () => ({
      query: pool.query,
      release,
    }));
    const res = await request(app).post(url).attach('audio', take(), 'take-2.mp3');
    expect(res.status).toBe(500);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    // Errored connection handed back for destruction, not reuse.
    expect(release).toHaveBeenCalledWith(expect.any(Error));
    const [newKey] = storage.uploadFile.mock.calls[0] as [string];
    expect(storage.delete).toHaveBeenCalledWith(newKey);
    expect(storage.delete).not.toHaveBeenCalledWith(`audio/${PROJECT}/old-take.mp3`);
  });

  it('discards the new take if the database can’t be reached', async () => {
    const storage = makeStorage();
    _setStorageForTests(storage as unknown as ObjectStorage);
    const { app, pool } = makeApp(script());
    (pool as unknown as { connect: jest.Mock }).connect.mockImplementation(async () => {
      throw new Error('pool exhausted');
    });
    const res = await request(app).post(url).attach('audio', take(), 'take-2.mp3');
    expect(res.status).toBe(500);
    const [newKey] = storage.uploadFile.mock.calls[0] as [string];
    expect(storage.delete).toHaveBeenCalledWith(newKey);
  });

  // Once the row points at the new take it's live: a hiccup tidying up
  // the old one mustn't tell the editor the replace failed.
  it('still reports success if tidying up the old take fails', async () => {
    const storage = makeStorage();
    _setStorageForTests(storage as unknown as ObjectStorage);
    const answer = script();
    const { app } = makeApp(async (sql) => {
      if (sql.includes('FROM project_builds')) throw new Error('db blip');
      return answer(sql);
    });
    const res = await request(app).post(url).attach('audio', take(), 'take-2.mp3');
    expect(res.status).toBe(200);
    const [newKey] = storage.uploadFile.mock.calls[0] as [string];
    expect(storage.delete).not.toHaveBeenCalledWith(newKey);
  });

  it('400s without a file', async () => {
    _setStorageForTests(makeStorage() as unknown as ObjectStorage);
    const { app } = makeApp(async () => ({ rows: [] }));
    const res = await request(app).post(url);
    expect(res.status).toBe(400);
  });

  it('400s on a malformed audio id before accepting the upload', async () => {
    const storage = makeStorage();
    _setStorageForTests(storage as unknown as ObjectStorage);
    const { app, pool } = makeApp(async () => ({ rows: [] }));
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/audio/not-a-uuid/replace`)
      .attach('audio', take(), 'take-2.mp3');
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('DELETE /:audioId', () => {
  // The filename comes back from the delete itself, so a new take landing
  // between the lookup and the delete is the object removed, not stranded.
  it('deletes the object the row pointed at when it was deleted', async () => {
    const storage = makeStorage();
    _setStorageForTests(storage as unknown as ObjectStorage);
    const { app } = makeApp(async (sql) => {
      if (sql.startsWith('SELECT filename')) return { rows: [{ filename: 'old-take.mp3' }] };
      if (sql.startsWith('DELETE FROM audio_files'))
        return { rows: [{ filename: 'new-take.mp3' }] };
      return { rows: [] };
    });
    const res = await request(app).delete(`/api/projects/${PROJECT}/audio/${AUDIO}`);
    expect(res.status).toBe(200);
    expect(storage.delete).toHaveBeenCalledWith(`audio/${PROJECT}/new-take.mp3`);
  });
});
