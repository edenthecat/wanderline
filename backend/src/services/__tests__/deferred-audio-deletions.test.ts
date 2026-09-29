import { jest } from '@jest/globals';
import type { Pool } from 'pg';
import { _setStorageForTests, resetStorageForTests, type ObjectStorage } from '../storage.js';
import { flushDeferredAudioDeletions } from '../deferred-audio-deletions.js';

// Old takes replaced while a build ran are deleted once the project has
// no build in progress. The query decides which are due; this covers
// what's done with them.

const PROJECT = '11111111-1111-4111-8111-111111111111';

function storage(del: (key: string) => Promise<void>) {
  const s = {
    uploadFile: jest.fn(),
    downloadStream: jest.fn(),
    delete: jest.fn(del),
    exists: jest.fn(),
    size: jest.fn(),
    signedGetUrl: jest.fn(),
  };
  _setStorageForTests(s as unknown as ObjectStorage);
  return s;
}

afterEach(() => resetStorageForTests());

describe('flushDeferredAudioDeletions', () => {
  it('deletes each due object and forgets it', async () => {
    const s = storage(async () => undefined);
    const sqls: [string, unknown[]][] = [];
    const pool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        sqls.push([sql, params]);
        return sql.includes('SELECT d.project_id')
          ? { rows: [{ project_id: PROJECT, filename: 'old.mp3' }] }
          : { rows: [] };
      }),
    } as unknown as Pool;
    await flushDeferredAudioDeletions(pool, PROJECT);
    expect(s.delete).toHaveBeenCalledWith(`audio/${PROJECT}/old.mp3`);
    const forget = sqls.find(([sql]) => sql.startsWith('DELETE FROM deferred_audio_deletions'));
    expect(forget?.[1]).toEqual([PROJECT, 'old.mp3']);
    // Scoped to the project, and only once no build is in progress.
    expect(sqls[0][1]).toEqual([PROJECT]);
    expect(sqls[0][0]).toMatch(/status IN \('pending', 'processing'\)/);
  });

  it('keeps a deletion that failed so it’s tried again', async () => {
    storage(async () => {
      throw new Error('gcs down');
    });
    const sqls: string[] = [];
    const pool = {
      query: jest.fn(async (sql: string) => {
        sqls.push(sql);
        return sql.includes('SELECT d.project_id')
          ? { rows: [{ project_id: PROJECT, filename: 'old.mp3' }] }
          : { rows: [] };
      }),
    } as unknown as Pool;
    await flushDeferredAudioDeletions(pool);
    expect(sqls.some((sql) => sql.startsWith('DELETE FROM deferred_audio_deletions'))).toBe(false);
  });

  it('never throws', async () => {
    storage(async () => undefined);
    const pool = {
      query: jest.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as Pool;
    await expect(flushDeferredAudioDeletions(pool)).resolves.toBeUndefined();
  });
});
