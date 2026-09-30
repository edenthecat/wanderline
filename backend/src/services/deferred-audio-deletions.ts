// Deleting a replaced take once no build needs it.
//
// See migrations/1752200000000_deferred_audio_deletions.sql. Every old
// take is recorded in the same transaction that swaps it out (see the
// replace route), and removed here once the project has no build in
// progress: a running build is about to copy audio by name.

import type { Pool } from 'pg';
import { unlink } from 'fs/promises';
import { getStorage, audioKey } from './storage.js';
import { uploadPath } from './upload-path.js';
import { logger } from '../logger.js';

/**
 * Carry out deferred deletions for projects with no build in progress:
 * one project (when its build ends), or every project (on startup). Never
 * throws; a deletion that fails is kept and tried again next time.
 */
export async function flushDeferredAudioDeletions(pool: Pool, projectId?: string): Promise<void> {
  try {
    const due = await pool.query(
      `SELECT d.project_id, d.filename FROM deferred_audio_deletions d
       WHERE ($1::uuid IS NULL OR d.project_id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM project_builds b
           WHERE b.project_id = d.project_id
             AND b.status IN ('pending', 'processing') AND b.deleted_at IS NULL
         )
         -- The file could have been pointed back at this name since.
         AND NOT EXISTS (
           SELECT 1 FROM audio_files f
           WHERE f.project_id = d.project_id AND f.filename = d.filename
         )`,
      [projectId ?? null],
    );
    for (const row of due.rows as { project_id: string; filename: string }[]) {
      try {
        await getStorage().delete(audioKey(row.project_id, row.filename));
      } catch (err) {
        logger.warn({ err, filename: row.filename }, 'Deferred audio deletion failed; will retry');
        continue;
      }
      try {
        await unlink(uploadPath(row.project_id, row.filename));
      } catch {
        /* may not exist */
      }
      await pool.query(
        'DELETE FROM deferred_audio_deletions WHERE project_id = $1 AND filename = $2',
        [row.project_id, row.filename],
      );
    }
  } catch (err) {
    logger.warn({ err, projectId }, 'Failed to flush deferred audio deletions');
  }
}
