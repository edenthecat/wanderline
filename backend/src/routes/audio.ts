import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { mkdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getStorage, audioKey } from '../services/storage.js';
import { buildMatchTables, matchAudioFile } from '../services/audio-matcher.js';
import { UPLOAD_DIR } from '../config.js';
import { uploadPath } from '../services/upload-path.js';
import { flushDeferredAudioDeletions } from '../services/deferred-audio-deletions.js';

const execFileAsync = promisify(execFile);

// Convert WAV to MP3 using ffmpeg. execFile (argument array), not exec
// (shell string): inputPath/outputPath are built from a server-generated
// UUID plus a regex-sanitized extension, so no shell metacharacter should
// ever reach here today — but that safety lives entirely in that one
// sanitizer, and a shell string means any future caller of this function
// (or a future loosening of that regex) is one shell-metacharacter
// filename away from command injection. execFile never spawns a shell,
// so each argument reaches ffmpeg literally regardless of its content.
async function convertWavToMp3(inputPath: string, outputPath: string): Promise<void> {
  // Use high quality MP3 encoding: -q:a 2 is roughly equivalent to 192kbps VBR
  await execFileAsync('ffmpeg', [
    '-i',
    inputPath,
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '2',
    outputPath,
    '-y',
  ]);
  // Remove the original WAV file
  await unlink(inputPath);
}

// Configure multer for audio file uploads

// Project ids in the URL are always UUIDs generated server-side. We
// don't accept anything else — a bare `..` (or any other non-UUID
// value) would pass through requireProjectAccess for an admin because
// that middleware doesn't validate id shape, and multer's destination
// callback below runs BEFORE any route handler code. A path traversal
// there would land the uploaded file outside the project's uploads
// tree before the route body ever ran.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    // req.params.id is guaranteed to be a UUID by the router-level
    // middleware in createAudioRouter — bad ids get a clean 400 JSON
    // before multer runs, so we can build the destination path
    // straight from it here.
    const projectDir = join(UPLOAD_DIR, req.params.id);
    if (!existsSync(projectDir)) {
      await mkdir(projectDir, { recursive: true });
    }
    cb(null, projectDir);
  },
  filename: (req, file, cb) => {
    // Sanitize the extension: strip path separators and traversal, allow only
    // alphanumeric. A crafted originalname could otherwise inject `/` or `..`
    // into the filename, which then becomes part of the storage key.
    const rawExt = file.originalname.split('.').pop() || 'mp3';
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'mp3';
    cb(null, `${randomUUID()}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/mp3',
      'audio/x-wav',
      'audio/webm',
    ];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(mp3|wav|ogg|webm)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  },
});

const INVALID_OFFSET = Symbol('invalid offset');
const OFFSET_ERROR = 'offsetMs must be a whole number of milliseconds, 0 to 3600000, or null';

/**
 * A sound effect's offset from the request body. Undefined and null both
 * mean "as the passage starts". Anything else must be a whole number of
 * milliseconds within an hour (a passage longer than that isn't a
 * passage), so a typo in seconds can't park an effect nowhere.
 */
export function parseOffsetMs(value: unknown): number | null | typeof INVALID_OFFSET {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3_600_000) {
    return INVALID_OFFSET;
  }
  return value;
}

/**
 * Convert an uploaded file if it needs it (WAV becomes MP3) and persist
 * it to durable storage. Shared by a fresh upload and by uploading a new
 * take over an existing file. Returns null if storage failed, having
 * cleaned up the local copy: a row pointing at a missing object would
 * 404 forever on download.
 */
async function storeUploadedAudio(
  req: Request,
  projectId: string,
  file: Express.Multer.File,
): Promise<{ filename: string; mimeType: string; size: number } | null> {
  let finalFilename = file.filename;
  let finalMimeType = file.mimetype;
  let finalSize = file.size;

  // Convert WAV to MP3
  if (
    file.mimetype === 'audio/wav' ||
    file.mimetype === 'audio/x-wav' ||
    file.originalname.toLowerCase().endsWith('.wav')
  ) {
    const inputPath = uploadPath(projectId, file.filename);
    const mp3Filename = file.filename.replace(/\.[^.]+$/, '.mp3');
    const outputPath = uploadPath(projectId, mp3Filename);

    try {
      await convertWavToMp3(inputPath, outputPath);
      finalFilename = mp3Filename;
      finalMimeType = 'audio/mpeg';
      const stats = await stat(outputPath);
      finalSize = stats.size;
      req.log.info(
        { originalName: file.originalname, originalSize: file.size, finalSize },
        'Converted WAV to MP3',
      );
    } catch (err) {
      req.log.error({ err }, 'Failed to convert WAV to MP3');
      // Continue with original file if conversion fails
    }
  }

  const localPath = uploadPath(projectId, finalFilename);
  try {
    await getStorage().uploadFile(audioKey(projectId, finalFilename), localPath, finalMimeType);
  } catch (err) {
    req.log.error({ err }, 'Failed to persist audio to storage');
    try {
      await unlink(localPath);
    } catch {
      /* may not exist */
    }
    return null;
  }
  return { filename: finalFilename, mimeType: finalMimeType, size: finalSize };
}

export function createAudioRouter(pool: Pool): Router {
  const router = Router({ mergeParams: true });

  // Validate the :id URL param as a real UUID before any route runs.
  // This catches malformed ids at the router boundary so:
  //  - multer's destination callback (which fires before the handler
  //    body) always sees a well-formed id and never has to reject
  //  - the caller gets a clean 400 JSON response instead of an
  //    unhandled multer error bubbling up as a 500 / HTML page
  //  - route bodies that pass the id straight into pg (`WHERE id = $1`)
  //    don't need to individually guard against pg's uuid cast throwing
  router.use((req: Request, res: Response, next) => {
    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    next();
  });

  // List audio files for a project
  /**
   * @openapi
   * /projects/{id}/audio:
   *   get:
   *     summary: List audio files uploaded to a project.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Audio files.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 files:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string, format: uuid }
   *                       filename: { type: string }
   *                       originalName: { type: string, nullable: true }
   *                       sizeBytes: { type: integer }
   *                       mimeType: { type: string }
   *                       characterId: { type: string, format: uuid, nullable: true }
   *                       createdAt: { type: string, format: date-time }
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `
        SELECT * FROM audio_files
        WHERE project_id = $1
        ORDER BY created_at DESC
      `,
        [id],
      );

      res.json({ audioFiles: result.rows });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to list audio files');
      res.status(500).json({ error: 'Failed to list audio files' });
    }
  });

  // Upload audio file
  /**
   * @openapi
   * /projects/{id}/audio:
   *   post:
   *     summary: Upload a single audio file.
   *     description: |
   *       multipart/form-data with field `audio`. Optional `characterId`
   *       associates the file with a character (theme + grouping).
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             properties:
   *               audio: { type: string, format: binary }
   *               characterId: { type: string, format: uuid }
   *     responses:
   *       201: { description: Uploaded. }
   *       400: { description: No file or unsupported mime type. }
   */
  router.post('/', upload.single('audio'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const file = req.file;
      const category = req.body.category || 'voiceover';
      const characterId = req.body.characterId || null;

      // Validate category
      const validCategories = ['voiceover', 'choice', 'indicator', 'ambience', 'sfx', 'music'];
      if (!validCategories.includes(category)) {
        res
          .status(400)
          .json({ error: 'Invalid category. Must be one of: ' + validCategories.join(', ') });
        return;
      }

      if (!file) {
        res.status(400).json({ error: 'No audio file provided' });
        return;
      }

      // Check project exists
      const projectCheck = await pool.query('SELECT id FROM projects WHERE id = $1', [id]);
      if (projectCheck.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // If characterId provided, validate it exists
      if (characterId) {
        const charCheck = await pool.query(
          'SELECT id FROM characters WHERE id = $1 AND project_id = $2',
          [characterId, id],
        );
        if (charCheck.rows.length === 0) {
          res.status(400).json({ error: 'Character not found' });
          return;
        }
      }

      const stored = await storeUploadedAudio(req, id, file);
      if (!stored) {
        res.status(503).json({ error: 'Failed to persist audio to durable storage' });
        return;
      }
      const { filename: finalFilename, mimeType: finalMimeType, size: finalSize } = stored;

      const result = await pool.query(
        `
        INSERT INTO audio_files (project_id, filename, original_name, mime_type, size_bytes, category, character_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
        [id, finalFilename, file.originalname, finalMimeType, finalSize, category, characterId],
      );

      res.status(201).json({ audioFile: result.rows[0] });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to upload audio file');
      res.status(500).json({ error: 'Failed to upload audio file' });
    }
  });

  // Delete all audio files for project
  /**
   * @openapi
   * /projects/{id}/audio:
   *   delete:
   *     summary: Delete every audio file for a project.
   *     description: |
   *       Wipes audio_files rows + their durable-storage objects + all
   *       node_audio_assignments referencing them. Used by SettingsTab's
   *       "Delete all audio" danger-zone button.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Deleted.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 deleted: { type: integer }
   */
  router.delete('/', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Get all files for this project first
      const filesResult = await pool.query(
        'SELECT id, filename FROM audio_files WHERE project_id = $1',
        [id],
      );

      if (filesResult.rows.length === 0) {
        res.json({ success: true, deleted: 0, message: 'No audio files to delete' });
        return;
      }

      // Delete all assignments first (cascade should handle this, but being explicit)
      await pool.query('DELETE FROM node_audio_assignments WHERE project_id = $1', [id]);

      // Delete all audio file records
      await pool.query('DELETE FROM audio_files WHERE project_id = $1', [id]);

      // Delete from durable storage and any local copies
      const projectDir = join(UPLOAD_DIR, id);
      let filesDeleted = 0;
      for (const file of filesResult.rows) {
        try {
          await getStorage().delete(audioKey(id, file.filename));
        } catch (err) {
          req.log.warn({ err, filename: file.filename }, 'Failed to delete audio from storage');
        }
        const filePath = join(projectDir, file.filename);
        try {
          await unlink(filePath);
          filesDeleted++;
        } catch {
          // File may not exist, continue
        }
      }

      // Try to remove the project directory if empty
      try {
        const { rmdir } = await import('fs/promises');
        await rmdir(projectDir);
      } catch {
        // Directory may not be empty or not exist
      }

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      res.json({
        success: true,
        deleted: filesResult.rows.length,
        filesRemoved: filesDeleted,
        message: `Deleted ${filesResult.rows.length} audio files and their assignments`,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to delete all audio files');
      res.status(500).json({ error: 'Failed to delete all audio files' });
    }
  });

  // Upload a new take over an existing file.
  /**
   * @openapi
   * /projects/{id}/audio/{audioId}/replace:
   *   post:
   *     summary: Upload a new take in place of an existing audio file.
   *     description: |
   *       The file keeps its id, so every node it's attached to (and each
   *       sound effect's timing) picks up the new take with no reassigning.
   *       It's stored under a new name, so previews, builds and offline
   *       caches fetch the new audio rather than serving the old one.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: audioId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             required: [audio]
   *             properties:
   *               audio: { type: string, format: binary }
   *     responses:
   *       200: { description: Replaced. Returns the updated audio file. }
   *       400: { description: 'No file, or a malformed id.' }
   *       404: { description: No such audio file in this project. }
   *       503: { description: Durable storage unavailable; nothing changed. }
   */
  router.post(
    '/:audioId/replace',
    // Reject a bad id before multer writes anything to disk.
    (req: Request, res: Response, next) => {
      if (!UUID_RE.test(req.params.audioId)) {
        res.status(400).json({ error: 'Invalid audio id' });
        return;
      }
      next();
    },
    // Multer's own errors (a format it won't take, a file over the limit)
    // otherwise fall through to Express's default HTML 500, which the
    // editor can't turn into a message. Anything else (the disk, say) is
    // a server fault: a 500 without the raw message, which can carry a
    // server path.
    (req: Request, res: Response, next) => {
      upload.single('audio')(req, res, (err: unknown) => {
        if (!err) return next();
        const error = err as Error & { code?: string };
        if (error.message === 'Only audio files are allowed') {
          return res
            .status(400)
            .json({ error: 'Only audio files (mp3, wav, ogg, webm) are allowed' });
        }
        if (err instanceof multer.MulterError) {
          return res.status(400).json({
            error:
              err.code === 'LIMIT_FILE_SIZE' ? 'That file is over the 50 MB limit' : err.message,
          });
        }
        req.log.error({ err }, 'Upload failed before the replace route ran');
        return res.status(500).json({ error: 'Failed to receive the upload' });
      });
    },
    async (req: Request, res: Response) => {
      const { id, audioId } = req.params;
      const file = req.file;
      const unlinkLocal = async (filename: string) => {
        try {
          await unlink(uploadPath(id, filename));
        } catch {
          /* may not exist */
        }
      };
      let stored: Awaited<ReturnType<typeof storeUploadedAudio>> = null;
      // Until the row points at the new take, it's ours to clean up.
      const discardNewTake = async () => {
        if (file) await unlinkLocal(file.filename);
        if (!stored) return;
        await unlinkLocal(stored.filename);
        try {
          await getStorage().delete(audioKey(id, stored.filename));
        } catch (err) {
          req.log.warn({ err }, 'Failed to delete orphaned replacement audio');
        }
      };

      let oldFilename: string | null = null;
      let audioFile: Record<string, unknown> | null = null;
      try {
        if (!file) {
          res.status(400).json({ error: 'No audio file provided' });
          return;
        }
        const existing = await pool.query(
          'SELECT 1 FROM audio_files WHERE id = $1 AND project_id = $2',
          [audioId, id],
        );
        if (existing.rows.length === 0) {
          await discardNewTake();
          res.status(404).json({ error: 'Audio file not found' });
          return;
        }

        stored = await storeUploadedAudio(req, id, file);
        if (!stored) {
          await discardNewTake();
          res.status(503).json({ error: 'Failed to persist audio to durable storage' });
          return;
        }

        // Same row, new object. Duration is the old take's, so it's
        // cleared rather than left wrong. The old filename is read under a
        // row lock in the same transaction as the update, so two replaces
        // (or a replace and a delete) racing can't each think they own the
        // same old take and strand the other's new one.
        const client = await pool.connect();
        let failure: Error | undefined;
        try {
          await client.query('BEGIN');
          const locked = await client.query(
            'SELECT filename FROM audio_files WHERE id = $1 AND project_id = $2 FOR UPDATE',
            [audioId, id],
          );
          if (locked.rows.length > 0) {
            oldFilename = locked.rows[0].filename;
            const updated = await client.query(
              `UPDATE audio_files
               SET filename = $3, original_name = $4, mime_type = $5, size_bytes = $6,
                   duration_ms = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id = $1 AND project_id = $2
               RETURNING *`,
              [audioId, id, stored.filename, file.originalname, stored.mimeType, stored.size],
            );
            audioFile = updated.rows[0] ?? null;
            // The old take is now referenced by nothing. Record that in
            // the same transaction as the swap, so it can't be orphaned by
            // anything failing after the commit; the deferred flush below
            // (or the next one) deletes it once no build still needs it.
            if (oldFilename && oldFilename !== stored.filename) {
              await client.query(
                `INSERT INTO deferred_audio_deletions (project_id, filename) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [id, oldFilename],
              );
            }
          }
          await client.query('COMMIT');
        } catch (err) {
          failure = err as Error;
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          // A connection that errored goes back broken; let the pool drop it.
          client.release(failure);
        }
      } catch (error) {
        await discardNewTake();
        req.log.error({ err: error }, 'Failed to replace audio file');
        res.status(500).json({ error: 'Failed to replace audio file' });
        return;
      }

      if (!audioFile) {
        // Deleted while we were uploading.
        await discardNewTake();
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }

      // Committed: the new take is live, so from here nothing may report
      // failure or touch it. The old take was recorded for deletion in the
      // transaction; the flush deletes it now unless a build is running (a
      // build copies audio by the filenames it has already assembled), in
      // which case the build's own flush, or startup's, gets it later.
      // Never throws.
      await flushDeferredAudioDeletions(pool, id);
      try {
        await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
      } catch (err) {
        req.log.warn({ err }, 'Replaced audio, but bumping the project timestamp failed');
      }
      res.json({ audioFile });
    },
  );

  // Update audio file category and/or character
  router.patch('/:audioId', async (req: Request, res: Response) => {
    try {
      const { id, audioId } = req.params;
      const { category, characterId } = req.body;

      // Build dynamic update query
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      // Validate and add category if provided
      if (category !== undefined) {
        const validCategories = ['voiceover', 'choice', 'indicator', 'ambience', 'sfx', 'music'];
        if (!validCategories.includes(category)) {
          res
            .status(400)
            .json({ error: 'Invalid category. Must be one of: ' + validCategories.join(', ') });
          return;
        }
        updates.push(`category = $${paramIndex++}`);
        values.push(category);
      }

      // Handle character_id (can be set to null to unassign)
      if (characterId !== undefined) {
        if (characterId !== null) {
          // Validate character exists for this project
          const charCheck = await pool.query(
            'SELECT id FROM characters WHERE id = $1 AND project_id = $2',
            [characterId, id],
          );
          if (charCheck.rows.length === 0) {
            res.status(400).json({ error: 'Character not found' });
            return;
          }
        }
        updates.push(`character_id = $${paramIndex++}`);
        values.push(characterId);
      }

      if (updates.length === 0) {
        res.status(400).json({ error: 'No valid updates provided' });
        return;
      }

      values.push(audioId, id);
      const result = await pool.query(
        `
        UPDATE audio_files
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramIndex++} AND project_id = $${paramIndex}
        RETURNING *
      `,
        values,
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }

      res.json({ audioFile: result.rows[0] });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update audio file');
      res.status(500).json({ error: 'Failed to update audio file' });
    }
  });

  // Delete audio file
  /**
   * @openapi
   * /projects/{id}/audio/{audioId}:
   *   delete:
   *     summary: Delete a single audio file.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: audioId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Deleted.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *       404: { description: Audio file not found. }
   */
  router.delete('/:audioId', async (req: Request, res: Response) => {
    try {
      const { id, audioId } = req.params;

      // Get file info first
      const fileResult = await pool.query(
        'SELECT filename FROM audio_files WHERE id = $1 AND project_id = $2',
        [audioId, id],
      );

      if (fileResult.rows.length === 0) {
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }

      // Delete from database (cascades to assignments). The filename comes
      // back from the delete itself: a new take uploaded between the read
      // above and here would otherwise be the object left behind.
      const deleted = await pool.query(
        'DELETE FROM audio_files WHERE id = $1 AND project_id = $2 RETURNING filename',
        [audioId, id],
      );
      if (deleted.rows.length === 0) {
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }

      // Delete from durable storage and any local copy
      const filename = deleted.rows[0].filename;
      try {
        await getStorage().delete(audioKey(id, filename));
      } catch (err) {
        req.log.warn({ err }, 'Failed to delete audio from storage');
      }
      try {
        await unlink(join(UPLOAD_DIR, id, filename));
      } catch {
        /* may not exist */
      }

      res.json({ success: true, deleted: audioId });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to delete audio file');
      res.status(500).json({ error: 'Failed to delete audio file' });
    }
  });

  // Get audio assignments for a project
  /**
   * @openapi
   * /projects/{id}/audio/assignments:
   *   get:
   *     summary: List node→audio assignments for a project.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Assignments by node.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 assignments:
   *                   type: object
   *                   additionalProperties:
   *                     type: object
   *                     properties:
   *                       voiceover: { type: string, format: uuid, nullable: true }
   *                       ambience: { type: string, format: uuid, nullable: true }
   *                       choice1: { type: string, format: uuid, nullable: true }
   *                       choice2: { type: string, format: uuid, nullable: true }
   *                       sfx:
   *                         type: array
   *                         items: { type: string, format: uuid }
   *                       sfxOffsets:
   *                         type: object
   *                         description: |
   *                           Milliseconds into the passage each sound effect plays
   *                           at, keyed by file id. Absent for one that plays as the
   *                           passage starts.
   *                         additionalProperties: { type: integer, minimum: 0 }
   */
  router.get('/assignments', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `
        SELECT naa.*, af.filename, af.original_name, af.mime_type
        FROM node_audio_assignments naa
        JOIN audio_files af ON naa.audio_file_id = af.id
        WHERE naa.project_id = $1
        ORDER BY naa.node_id, naa.audio_type
      `,
        [id],
      );

      // Group by node_id
      const assignments: Record<
        string,
        {
          voiceover?: string;
          ambience?: string;
          choice1?: string;
          choice2?: string;
          sfx: string[];
          sfxOffsets?: Record<string, number>;
        }
      > = {};
      for (const row of result.rows) {
        if (!assignments[row.node_id]) {
          assignments[row.node_id] = { sfx: [] };
        }
        if (row.audio_type === 'sfx') {
          const node = assignments[row.node_id];
          node.sfx.push(row.audio_file_id);
          if (typeof row.offset_ms === 'number') {
            (node.sfxOffsets ??= {})[row.audio_file_id] = row.offset_ms;
          }
        } else {
          assignments[row.node_id][
            row.audio_type as 'voiceover' | 'ambience' | 'choice1' | 'choice2'
          ] = row.audio_file_id;
        }
      }

      res.json({ assignments, raw: result.rows });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get audio assignments');
      res.status(500).json({ error: 'Failed to get audio assignments' });
    }
  });

  // Assign audio to a node
  /**
   * @openapi
   * /projects/{id}/audio/assignments:
   *   post:
   *     summary: Assign (or replace) one audio slot on a node.
   *     description: |
   *       Slots are `voiceover`, `ambience`, `choice1`, `choice2`.
   *       Posting an existing (nodeId, audioType) pair replaces the
   *       previous file_id.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [nodeId, audioType, audioFileId]
   *             properties:
   *               nodeId: { type: string }
   *               audioType: { type: string, enum: [voiceover, ambience, choice1, choice2, sfx] }
   *               audioFileId: { type: string, format: uuid }
   *               offsetMs:
   *                 type: integer
   *                 minimum: 0
   *                 nullable: true
   *                 description: sfx only. When to play it; omit or null for as the passage starts.
   *               expectEmpty:
   *                 type: boolean
   *                 description: Refuse with 409 instead of replacing if the slot is already filled.
   *     responses:
   *       200: { description: Assigned. }
   *       400: { description: Missing / invalid fields. }
   *       409: { description: expectEmpty was set and the slot is already filled. }
   */
  router.post('/assignments', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, audioType, audioFileId, offsetMs, expectEmpty } = req.body;

      if (!nodeId || !audioType || !audioFileId) {
        res.status(400).json({ error: 'nodeId, audioType, and audioFileId are required' });
        return;
      }
      const offset = parseOffsetMs(offsetMs);
      if (offset === INVALID_OFFSET) {
        res.status(400).json({ error: OFFSET_ERROR });
        return;
      }
      if (offset !== null && audioType !== 'sfx') {
        res.status(400).json({ error: 'offsetMs only applies to sfx' });
        return;
      }

      if (!['voiceover', 'ambience', 'sfx', 'choice1', 'choice2'].includes(audioType)) {
        res
          .status(400)
          .json({ error: 'audioType must be voiceover, ambience, sfx, choice1, or choice2' });
        return;
      }

      // A sound effect's timing: an explicit null resets it to the start,
      // while leaving offsetMs out keeps whatever it was (so re-posting an
      // attached effect from the Audio tab doesn't lose its timing).
      const offsetGiven = offsetMs !== undefined;

      // A single slot's check, clear and fill run in one transaction under
      // a lock on that slot, so two attaches can't both see it empty (and
      // expectEmpty can't be sidestepped by a peer's concurrent attach).
      const client = await pool.connect();
      let failure: Error | undefined;
      let result: { rows: unknown[] };
      try {
        await client.query('BEGIN');
        if (audioType !== 'sfx') {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `${id}:${nodeId}:${audioType}`,
          ]);
          // An editor attaching to what it saw as an empty slot asks for
          // this, so a take a peer attached in the meantime isn't
          // silently replaced.
          if (expectEmpty === true) {
            const existing = await client.query(
              `SELECT 1 FROM node_audio_assignments
               WHERE project_id = $1 AND node_id = $2 AND audio_type = $3`,
              [id, nodeId, audioType],
            );
            if (existing.rows.length > 0) {
              await client.query('ROLLBACK');
              res.status(409).json({ error: `${nodeId} already has ${audioType} audio attached` });
              return;
            }
          }
          // For voiceover, ambience, choice1, choice2 - replace existing assignment (sfx can have multiple)
          await client.query(
            `DELETE FROM node_audio_assignments
             WHERE project_id = $1 AND node_id = $2 AND audio_type = $3`,
            [id, nodeId, audioType],
          );
        }
        result = await client.query(
          `INSERT INTO node_audio_assignments (project_id, node_id, audio_type, audio_file_id, offset_ms)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id, node_id, audio_type, audio_file_id)
           DO UPDATE SET offset_ms = CASE WHEN $6 THEN EXCLUDED.offset_ms
                                          ELSE node_audio_assignments.offset_ms END,
                         updated_at = CURRENT_TIMESTAMP
           RETURNING *`,
          [id, nodeId, audioType, audioFileId, offset, offsetGiven],
        );
        await client.query('COMMIT');
      } catch (err) {
        failure = err as Error;
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release(failure);
      }

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      res.status(201).json({ assignment: result.rows[0] || { nodeId, audioType, audioFileId } });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to assign audio');
      res.status(500).json({ error: 'Failed to assign audio' });
    }
  });

  // Set or clear when one sound effect plays.
  /**
   * @openapi
   * /projects/{id}/audio/assignments/{nodeId}/sfx/{audioFileId}:
   *   patch:
   *     summary: Set when one of a node's sound effects plays.
   *     description: |
   *       Milliseconds into the narration (or after arriving, on a passage
   *       with no narration). Null plays it as the passage starts.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: nodeId
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: audioFileId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [offsetMs]
   *             properties:
   *               offsetMs: { type: integer, minimum: 0, maximum: 3600000, nullable: true }
   *     responses:
   *       200: { description: Updated. }
   *       400: { description: Invalid offset. }
   *       404: { description: That sound effect isn't attached to this node. }
   */
  router.patch('/assignments/:nodeId/sfx/:audioFileId', async (req: Request, res: Response) => {
    try {
      const { id, nodeId, audioFileId } = req.params;
      if (!UUID_RE.test(audioFileId)) {
        res.status(400).json({ error: 'audioFileId must be a UUID' });
        return;
      }
      if (!('offsetMs' in (req.body ?? {}))) {
        res.status(400).json({ error: 'offsetMs is required (null to play at the start)' });
        return;
      }
      const offset = parseOffsetMs(req.body.offsetMs);
      if (offset === INVALID_OFFSET) {
        res.status(400).json({ error: OFFSET_ERROR });
        return;
      }
      const result = await pool.query(
        `UPDATE node_audio_assignments
           SET offset_ms = $4, updated_at = CURRENT_TIMESTAMP
           WHERE project_id = $1 AND node_id = $2 AND audio_type = 'sfx' AND audio_file_id = $3
           RETURNING *`,
        [id, nodeId, audioFileId, offset],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Sound effect not attached to this node' });
        return;
      }
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
      res.json({ assignment: result.rows[0] });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to set sound effect offset');
      res.status(500).json({ error: 'Failed to set sound effect offset' });
    }
  });

  // Remove audio assignment
  /**
   * @openapi
   * /projects/{id}/audio/assignments/{nodeId}/{audioType}:
   *   delete:
   *     summary: Clear one audio slot on a node.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: nodeId
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: audioType
   *         required: true
   *         schema: { type: string, enum: [voiceover, ambience, choice1, choice2] }
   *     responses:
   *       200: { description: Cleared (or already empty). }
   */
  router.delete('/assignments/:nodeId/:audioType', async (req: Request, res: Response) => {
    try {
      const { id, nodeId, audioType } = req.params;
      const { audioFileId } = req.query;

      let query = `
        DELETE FROM node_audio_assignments
        WHERE project_id = $1 AND node_id = $2 AND audio_type = $3
      `;
      const params: (string | undefined)[] = [id, nodeId, audioType];

      // For sfx, we might want to remove a specific file
      if (audioFileId) {
        query += ' AND audio_file_id = $4';
        params.push(audioFileId as string);
      }

      query += ' RETURNING *';

      const result = await pool.query(query, params);

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      res.json({ success: true, deleted: result.rows });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to remove assignment');
      res.status(500).json({ error: 'Failed to remove assignment' });
    }
  });

  // Bulk re-point a batch of assignments from one audio file to another.
  // Each op identifies a SPECIFIC (nodeId, audioType, fromFileId) tuple
  // and the toFileId to swap in. The whole batch runs in a transaction
  // so it's all-or-nothing — half-applied swaps would leave the player
  // in a worse state than the starting one.
  //
  // The typical use case is "I just uploaded better versions of the
  // audio that's already assigned across the story" — pick one bad
  // file in the library, see every place it's used, hit Swap.
  /**
   * @openapi
   * /projects/{id}/audio/assignments/bulk-reassign:
   *   post:
   *     summary: Bulk re-point assignments from one audio file to another.
   *     description: |
   *       Transactional swap: each op removes a specific (nodeId, audioType,
   *       fromFileId) assignment and inserts the same (nodeId, audioType,
   *       toFileId). For single-slot types (voiceover/ambience/choice1/
   *       choice2) the from-row is dropped and the to-row replaces it. For
   *       sfx the from-row is dropped and the to-row inserted alongside any
   *       other sfx already there. If any op fails (e.g. the fromFileId
   *       isn't actually assigned, or the toFileId doesn't exist in this
   *       project's library) the whole batch rolls back.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               ops:
   *                 type: array
   *                 items:
   *                   type: object
   *                   required: [nodeId, audioType, fromFileId, toFileId]
   *                   properties:
   *                     nodeId: { type: string }
   *                     audioType: { type: string, enum: [voiceover, ambience, choice1, choice2, sfx] }
   *                     fromFileId: { type: string, format: uuid }
   *                     toFileId: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: All ops applied.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *                 swapped: { type: integer }
   *       400: { description: 'Bad op (missing/invalid fields, unknown file, no matching assignment).' }
   */
  router.post('/assignments/bulk-reassign', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { ops } = req.body as {
      ops?: Array<{
        nodeId: string;
        audioType: string;
        fromFileId: string;
        toFileId: string;
      }>;
    };

    if (!Array.isArray(ops) || ops.length === 0) {
      res.status(400).json({ error: 'ops must be a non-empty array' });
      return;
    }
    // Pre-validate every field so a malformed body produces 400, not
    // a downstream pg `22P02 invalid_text_representation` that the
    // catch block would otherwise turn into a 500.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const op of ops) {
      if (!op.nodeId || !op.audioType || !op.fromFileId || !op.toFileId) {
        res.status(400).json({
          error: 'every op must include nodeId, audioType, fromFileId, toFileId',
        });
        return;
      }
      if (!['voiceover', 'ambience', 'sfx', 'choice1', 'choice2'].includes(op.audioType)) {
        res.status(400).json({
          error: `audioType must be voiceover/ambience/sfx/choice1/choice2; got "${op.audioType}"`,
        });
        return;
      }
      if (!UUID_RE.test(op.fromFileId) || !UUID_RE.test(op.toFileId)) {
        res.status(400).json({ error: 'fromFileId and toFileId must be UUIDs' });
        return;
      }
      if (op.fromFileId === op.toFileId) {
        // No-op rows would just churn the table; reject early so the
        // caller knows their UI is sending pointless rows.
        res.status(400).json({ error: 'fromFileId and toFileId must differ' });
        return;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Validate every target file exists in THIS project's library
      // up front. Doing it in one query is cheaper than re-checking
      // per op, and lets us return a clean 400 before any mutation.
      const toFileIds = Array.from(new Set(ops.map((o) => o.toFileId)));
      const fileCheck = await client.query(
        `SELECT id FROM audio_files WHERE project_id = $1 AND id = ANY($2::uuid[])`,
        [id, toFileIds],
      );
      if (fileCheck.rows.length !== toFileIds.length) {
        await client.query('ROLLBACK');
        res.status(400).json({
          error: "one or more toFileIds aren't in this project's audio library",
        });
        return;
      }

      // Take the same per-slot lock POST /assignments does for every
      // single-value slot touched, so a concurrent attach can't slip a
      // second file into one of them mid-swap. Taken in order of the lock
      // ids themselves (not the key strings, whose order a hash collision
      // could invert), so two swaps over the same slots can't deadlock on
      // these locks.
      const slotKeys = [
        ...new Set(
          ops
            .filter((op) => op.audioType !== 'sfx')
            .map((op) => `${id}:${op.nodeId}:${op.audioType}`),
        ),
      ];
      if (slotKeys.length > 0) {
        const lockIds = await client.query(
          'SELECT DISTINCT hashtext(k) AS lock_id FROM unnest($1::text[]) AS k ORDER BY lock_id',
          [slotKeys],
        );
        for (const { lock_id } of lockIds.rows as { lock_id: number }[]) {
          await client.query('SELECT pg_advisory_xact_lock($1::int)', [lock_id]);
        }
      }

      let swapped = 0;
      for (const op of ops) {
        const del = await client.query(
          `DELETE FROM node_audio_assignments
           WHERE project_id = $1 AND node_id = $2 AND audio_type = $3 AND audio_file_id = $4
           RETURNING id, offset_ms`,
          [id, op.nodeId, op.audioType, op.fromFileId],
        );
        if (del.rows.length === 0) {
          // The op promised this assignment existed; if not, the
          // caller's view of the world is stale. Roll back so they
          // re-fetch instead of half-applying.
          await client.query('ROLLBACK');
          res.status(400).json({
            error: `no assignment found for node "${op.nodeId}" (${op.audioType}) → file ${op.fromFileId}`,
          });
          return;
        }
        // Swapping in a new take keeps the effect's timing: the author
        // placed it against the words, not against the file.
        const inserted = await client.query(
          `INSERT INTO node_audio_assignments (project_id, node_id, audio_type, audio_file_id, offset_ms)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id, node_id, audio_type, audio_file_id) DO NOTHING
           RETURNING id`,
          [id, op.nodeId, op.audioType, op.toFileId, del.rows[0].offset_ms ?? null],
        );
        if (inserted.rows.length === 0) {
          // The target is already attached to this node (the node had both
          // files, or a peer attached it meanwhile). Merge rather than
          // fail: "swap everywhere" would otherwise never succeed on such a
          // node. The target keeps its own timing if it has one, and
          // otherwise takes the source's, so the effect isn't moved.
          await client.query(
            `UPDATE node_audio_assignments
             SET offset_ms = COALESCE(offset_ms, $5), updated_at = CURRENT_TIMESTAMP
             WHERE project_id = $1 AND node_id = $2 AND audio_type = $3 AND audio_file_id = $4`,
            [id, op.nodeId, op.audioType, op.toFileId, del.rows[0].offset_ms ?? null],
          );
        }
        swapped += 1;
      }

      await client.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
      await client.query('COMMIT');

      res.json({ success: true, swapped });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      req.log.error({ err: error }, 'Failed to bulk-reassign audio');
      res.status(500).json({ error: 'Failed to bulk-reassign audio' });
    } finally {
      client.release();
    }
  });

  // Get audio coverage stats (nodes without audio, orphaned files)
  /**
   * @openapi
   * /projects/{id}/audio/coverage:
   *   get:
   *     summary: Audio coverage report (assignments + orphaned files).
   *     description: |
   *       Per-node assignment status plus a list of audio files that
   *       exist on disk but aren't referenced by any node — used by
   *       the AudioTab's Orphaned Audio panel.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Coverage report.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 coveredNodeCount: { type: integer }
   *                 totalNodeCount: { type: integer }
   *                 orphanedAudioFiles:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string, format: uuid }
   *                       name: { type: string }
   *                       sizeBytes: { type: integer }
   *                       mimeType: { type: string }
   *                       createdAt: { type: string, format: date-time }
   */
  router.get('/coverage', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Get story graph to know all node IDs
      const storyResult = await pool.query(
        'SELECT story_graph FROM project_stories WHERE project_id = $1',
        [id],
      );

      if (storyResult.rows.length === 0) {
        res.json({
          nodesWithoutAudio: [],
          orphanedAudioFiles: [],
          coverage: { total: 0, withAudio: 0, percentage: 0 },
        });
        return;
      }

      const storyGraph = storyResult.rows[0].story_graph;
      const allNodeIds = Object.keys(storyGraph.nodes || {});

      // Get all node IDs that have voiceover assigned (primary audio type)
      const assignedResult = await pool.query(
        `
        SELECT DISTINCT node_id FROM node_audio_assignments
        WHERE project_id = $1 AND audio_type = 'voiceover'
      `,
        [id],
      );
      const nodesWithVoiceover = new Set(assignedResult.rows.map((r) => r.node_id));

      // Find nodes without voiceover
      const nodesWithoutAudio = allNodeIds.filter((nodeId) => !nodesWithVoiceover.has(nodeId));

      // Get all audio files — pulled with the metadata the orphans UI
      // needs to surface: size + upload date + mime type.
      const audioFilesResult = await pool.query(
        `SELECT id, original_name, size_bytes, mime_type, created_at
         FROM audio_files WHERE project_id = $1`,
        [id],
      );

      // Get all assigned audio file IDs
      const assignedFilesResult = await pool.query(
        'SELECT DISTINCT audio_file_id FROM node_audio_assignments WHERE project_id = $1',
        [id],
      );
      const assignedFileIds = new Set(assignedFilesResult.rows.map((r) => r.audio_file_id));

      // Find orphaned files (uploaded but not assigned)
      const orphanedAudioFiles = audioFilesResult.rows
        .filter((f) => !assignedFileIds.has(f.id))
        .map((f) => ({
          id: f.id,
          name: f.original_name,
          sizeBytes: f.size_bytes,
          mimeType: f.mime_type,
          createdAt: f.created_at,
        }));

      const totalNodes = allNodeIds.length;
      const withAudio = totalNodes - nodesWithoutAudio.length;

      res.json({
        nodesWithoutAudio,
        orphanedAudioFiles,
        coverage: {
          total: totalNodes,
          withAudio,
          percentage: totalNodes > 0 ? Math.round((withAudio / totalNodes) * 100) : 0,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get audio coverage');
      res.status(500).json({ error: 'Failed to get audio coverage' });
    }
  });

  // Bulk upload audio files with auto-matching
  router.post(
    '/bulk',
    (req: Request, res: Response, next) => {
      upload.array('audio', 50)(req, res, (err: unknown) => {
        const error = err as (Error & { code?: string }) | undefined;
        if (error) {
          req.log.error({ err: error, code: error.code }, 'Multer error');
          if (error.code === 'LIMIT_UNEXPECTED_FILE') {
            return res
              .status(400)
              .json({ error: 'Invalid field name. Use "audio" for file upload.' });
          }
          if (error.message === 'Only audio files are allowed') {
            return res
              .status(400)
              .json({ error: 'Only audio files (mp3, wav, ogg, webm) are allowed' });
          }
          return res.status(400).json({ error: error.message || 'Upload failed' });
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const files = req.files as Express.Multer.File[];
        const category = req.body.category || 'voiceover';
        const characterId = req.body.characterId || null;

        if (!files || files.length === 0) {
          res.status(400).json({ error: 'No audio files provided' });
          return;
        }

        // Validate category
        const validCategories = ['voiceover', 'choice', 'indicator', 'ambience', 'sfx', 'music'];
        if (!validCategories.includes(category)) {
          res
            .status(400)
            .json({ error: 'Invalid category. Must be one of: ' + validCategories.join(', ') });
          return;
        }

        // Check project exists and get story graph for matching
        const projectResult = await pool.query(
          `
        SELECT p.id, ps.story_graph
        FROM projects p
        LEFT JOIN project_stories ps ON p.id = ps.project_id
        WHERE p.id = $1
      `,
          [id],
        );

        if (projectResult.rows.length === 0) {
          res.status(404).json({ error: 'Project not found' });
          return;
        }

        // If characterId provided, validate it exists
        if (characterId) {
          const charCheck = await pool.query(
            'SELECT id FROM characters WHERE id = $1 AND project_id = $2',
            [characterId, id],
          );
          if (charCheck.rows.length === 0) {
            res.status(400).json({ error: 'Character not found' });
            return;
          }
        }

        const storyGraph = projectResult.rows[0].story_graph;
        const nodes = storyGraph?.nodes || {};
        // Use the shared audio matcher so bulk-upload and rematch
        // can't drift apart again.
        const matchTables = buildMatchTables(nodes);

        const results = {
          uploaded: [] as { id: string; filename: string; originalName: string }[],
          matched: [] as {
            audioFileId: string;
            nodeId: string;
            audioType: string;
            filename: string;
          }[],
          unmatched: [] as { audioFileId: string; filename: string }[],
        };

        for (const file of files) {
          let finalFilename = file.filename;
          let finalMimeType = file.mimetype;
          let finalSize = file.size;

          // Convert WAV to MP3
          if (
            file.mimetype === 'audio/wav' ||
            file.mimetype === 'audio/x-wav' ||
            file.originalname.toLowerCase().endsWith('.wav')
          ) {
            const inputPath = join(UPLOAD_DIR, id, file.filename);
            const mp3Filename = file.filename.replace(/\.[^.]+$/, '.mp3');
            const outputPath = join(UPLOAD_DIR, id, mp3Filename);

            try {
              await convertWavToMp3(inputPath, outputPath);
              finalFilename = mp3Filename;
              finalMimeType = 'audio/mpeg';
              const stats = await stat(outputPath);
              finalSize = stats.size;
              req.log.info(
                { originalName: file.originalname, originalSize: file.size, finalSize },
                'Converted WAV to MP3 (bulk)',
              );
            } catch (err) {
              req.log.error({ err }, 'Failed to convert WAV to MP3');
              // Continue with original file if conversion fails
            }
          }

          // Persist to durable storage. If storage fails, skip the DB insert
          // for this file rather than create a permanently broken record.
          try {
            await getStorage().uploadFile(
              audioKey(id, finalFilename),
              join(UPLOAD_DIR, id, finalFilename),
              finalMimeType,
            );
          } catch (err) {
            req.log.error({ err }, 'Failed to persist bulk-uploaded audio to storage');
            try {
              await unlink(join(UPLOAD_DIR, id, finalFilename));
            } catch {
              /* */
            }
            continue;
          }

          // Insert file into database with category and characterId
          const insertResult = await pool.query(
            `
          INSERT INTO audio_files (project_id, filename, original_name, mime_type, size_bytes, category, character_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
        `,
            [id, finalFilename, file.originalname, finalMimeType, finalSize, category, characterId],
          );

          const audioFile = insertResult.rows[0];
          results.uploaded.push({
            id: audioFile.id,
            filename: audioFile.filename,
            originalName: audioFile.original_name,
          });

          // Match this file to a story node via the shared matcher.
          const match = matchAudioFile(file.originalname, matchTables);
          const matchedNodeId = match?.nodeId;
          const matchedAudioType: string = match?.audioType ?? 'voiceover';

          if (matchedNodeId) {
            // Auto-assign with the determined audio type
            await pool.query(
              `
            INSERT INTO node_audio_assignments (project_id, node_id, audio_type, audio_file_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (project_id, node_id, audio_type, audio_file_id) DO NOTHING
          `,
              [id, matchedNodeId, matchedAudioType, audioFile.id],
            );

            // If character is specified and it's a voiceover, also assign character to the node
            if (characterId && matchedAudioType === 'voiceover') {
              await pool.query(
                `
              INSERT INTO node_metadata (project_id, node_id, character_id)
              VALUES ($1, $2, $3)
              ON CONFLICT (project_id, node_id)
              DO UPDATE SET character_id = $3, updated_at = CURRENT_TIMESTAMP
            `,
                [id, matchedNodeId, characterId],
              );
            }

            results.matched.push({
              audioFileId: audioFile.id,
              nodeId: matchedNodeId,
              audioType: matchedAudioType,
              filename: file.originalname,
            });
          } else {
            results.unmatched.push({
              audioFileId: audioFile.id,
              filename: file.originalname,
            });
          }
        }

        // Update project timestamp
        await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

        res.status(201).json({
          success: true,
          totalUploaded: results.uploaded.length,
          totalMatched: results.matched.length,
          totalUnmatched: results.unmatched.length,
          ...results,
        });
      } catch (error) {
        req.log.error({ err: error }, 'Failed to bulk upload audio files');
        res.status(500).json({ error: 'Failed to bulk upload audio files' });
      }
    },
  );

  // Re-match existing unassigned audio files to nodes
  /**
   * @openapi
   * /projects/{id}/audio/assignments/audit:
   *   get:
   *     summary: Report assignments whose filename resolves elsewhere.
   *     description: |
   *       Read-only. Re-runs the matcher over every ALREADY-ASSIGNED
   *       audio file and reports the ones now pointing at a different
   *       node than the one they sit on.
   *
   *       `/rematch` cannot surface these: it skips any file that
   *       already has an assignment, so a project populated under
   *       older matching logic never gets re-examined. That was fine
   *       while the matcher only ever gained precision, but a matcher
   *       BUG leaves silently wrong assignments that nothing revisits.
   *
   *       Deliberately does not change anything. A filename that
   *       disagrees with its node is often intentional — an author may
   *       have assigned a clip by hand — so this produces a list to
   *       review rather than a correction to trust.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Assignments that disagree with the matcher.
   */
  router.get('/assignments/audit', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const projectResult = await pool.query(
        `SELECT p.id, ps.story_graph
           FROM projects p
           LEFT JOIN project_stories ps ON p.id = ps.project_id
          WHERE p.id = $1`,
        [id],
      );
      if (projectResult.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const storyGraph = projectResult.rows[0].story_graph;
      if (!storyGraph) {
        res.status(400).json({ error: 'No story uploaded yet' });
        return;
      }

      const matchTables = buildMatchTables(storyGraph.nodes);

      const rows = await pool.query(
        `SELECT naa.node_id, naa.audio_type, naa.audio_file_id,
                af.original_name, af.filename
           FROM node_audio_assignments naa
           JOIN audio_files af ON naa.audio_file_id = af.id
          WHERE naa.project_id = $1
          ORDER BY naa.node_id, naa.audio_type`,
        [id],
      );

      // Rows an author has already looked at and accepted. Keyed on the
      // exact assignment, so moving the clip re-raises it rather than
      // carrying a stale approval forward.
      const ackRows = await pool.query(
        `SELECT audio_file_id, node_id, audio_type
           FROM audio_assignment_audit_acks
          WHERE project_id = $1`,
        [id],
      );
      const ackKey = (fileId: string, nodeId: string, audioType: string) =>
        `${fileId}\u0000${nodeId}\u0000${audioType}`;
      const acked = new Set(
        ackRows.rows.map((r) => ackKey(r.audio_file_id, r.node_id, r.audio_type)),
      );
      let acknowledged = 0;

      const disagreements: {
        audioFileId: string;
        filename: string;
        currentNodeId: string;
        currentAudioType: string;
        suggestedNodeId: string | null;
        suggestedAudioType: string | null;
        reason: 'different-node' | 'different-type' | 'no-longer-matches';
        currentNodeExists: boolean;
      }[] = [];

      for (const row of rows.rows) {
        const match = matchAudioFile(row.original_name, matchTables);
        const suggestedNodeId = match?.nodeId ?? null;
        const suggestedAudioType = match?.audioType ?? null;

        // An unmatchable filename is not evidence of anything: plenty
        // of clips are named in ways the matcher was never meant to
        // read, and flagging them would bury the real signal.
        if (!suggestedNodeId) continue;
        if (suggestedNodeId === row.node_id && suggestedAudioType === row.audio_type) continue;

        // Counted rather than dropped silently: an author needs to be
        // able to tell "nothing is wrong" from "everything was waved
        // through months ago".
        if (acked.has(ackKey(row.audio_file_id, row.node_id, row.audio_type))) {
          acknowledged++;
          continue;
        }

        disagreements.push({
          audioFileId: row.audio_file_id,
          filename: row.original_name,
          currentNodeId: row.node_id,
          currentAudioType: row.audio_type,
          suggestedNodeId,
          suggestedAudioType,
          reason: suggestedNodeId !== row.node_id ? 'different-node' : 'different-type',
          // A node the story no longer contains is the strongest
          // signal in the report: the assignment cannot be correct.
          currentNodeExists: Object.prototype.hasOwnProperty.call(storyGraph.nodes, row.node_id),
        });
      }

      res.json({
        totalAssignments: rows.rows.length,
        acknowledged,
        disagreements,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to audit audio assignments');
      res.status(500).json({ error: 'Failed to audit audio assignments' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/audio/assignments/audit/ack:
   *   post:
   *     summary: Mark an audited assignment as intentional.
   *     description: |
   *       Hides one row from the audit report. Keyed on the specific
   *       assignment, so moving the clip to a different node re-raises
   *       it instead of carrying the approval forward.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200: { description: Acknowledged. }
   *   delete:
   *     summary: Un-mark an assignment, returning it to the report.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200: { description: Acknowledgement removed. }
   */
  router.post('/assignments/audit/ack', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { audioFileId, nodeId, audioType } = req.body ?? {};
      if (!audioFileId || !nodeId || !audioType) {
        res.status(400).json({ error: 'audioFileId, nodeId and audioType are required' });
        return;
      }
      // Scoped by project_id so a caller can't acknowledge a row on a
      // project they reached a file id from.
      const owned = await pool.query(
        `SELECT 1 FROM node_audio_assignments
          WHERE project_id = $1 AND audio_file_id = $2 AND node_id = $3 AND audio_type = $4`,
        [id, audioFileId, nodeId, audioType],
      );
      if (owned.rows.length === 0) {
        res.status(404).json({ error: 'Assignment not found' });
        return;
      }
      await pool.query(
        `INSERT INTO audio_assignment_audit_acks (project_id, audio_file_id, node_id, audio_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, audio_file_id, node_id, audio_type) DO NOTHING`,
        [id, audioFileId, nodeId, audioType],
      );
      res.json({ acknowledged: true });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to acknowledge audit row');
      res.status(500).json({ error: 'Failed to acknowledge' });
    }
  });

  router.delete('/assignments/audit/ack', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { audioFileId, nodeId, audioType } = req.body ?? {};
      if (!audioFileId || !nodeId || !audioType) {
        res.status(400).json({ error: 'audioFileId, nodeId and audioType are required' });
        return;
      }
      await pool.query(
        `DELETE FROM audio_assignment_audit_acks
          WHERE project_id = $1 AND audio_file_id = $2 AND node_id = $3 AND audio_type = $4`,
        [id, audioFileId, nodeId, audioType],
      );
      res.json({ acknowledged: false });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to remove audit acknowledgement');
      res.status(500).json({ error: 'Failed to remove acknowledgement' });
    }
  });

  router.post('/rematch', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Get story graph for matching
      const projectResult = await pool.query(
        `
        SELECT p.id, ps.story_graph
        FROM projects p
        LEFT JOIN project_stories ps ON p.id = ps.project_id
        WHERE p.id = $1
      `,
        [id],
      );

      if (projectResult.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const storyGraph = projectResult.rows[0].story_graph;
      if (!storyGraph) {
        res.status(400).json({ error: 'No story uploaded yet' });
        return;
      }

      const matchTables = buildMatchTables(storyGraph.nodes);

      // Get all audio files for this project
      const audioResult = await pool.query('SELECT * FROM audio_files WHERE project_id = $1', [id]);

      // Get existing assignments (all types)
      const assignmentsResult = await pool.query(
        'SELECT audio_file_id, audio_type FROM node_audio_assignments WHERE project_id = $1',
        [id],
      );
      const assignedFileIds = new Set(assignmentsResult.rows.map((r) => r.audio_file_id));

      const results = {
        matched: [] as {
          audioFileId: string;
          nodeId: string;
          audioType: string;
          filename: string;
        }[],
        alreadyAssigned: 0,
        unmatched: [] as { audioFileId: string; filename: string }[],
      };

      for (const audioFile of audioResult.rows) {
        // Skip if already assigned
        if (assignedFileIds.has(audioFile.id)) {
          results.alreadyAssigned++;
          continue;
        }

        // Match this file via the shared matcher.
        const match = matchAudioFile(audioFile.original_name, matchTables);
        const matchedNodeId = match?.nodeId;
        const matchedAudioType: string = match?.audioType ?? 'voiceover';

        if (matchedNodeId) {
          await pool.query(
            `
            INSERT INTO node_audio_assignments (project_id, node_id, audio_type, audio_file_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (project_id, node_id, audio_type, audio_file_id) DO NOTHING
          `,
            [id, matchedNodeId, matchedAudioType, audioFile.id],
          );

          results.matched.push({
            audioFileId: audioFile.id,
            nodeId: matchedNodeId,
            audioType: matchedAudioType,
            filename: audioFile.original_name,
          });
        } else {
          results.unmatched.push({
            audioFileId: audioFile.id,
            filename: audioFile.original_name,
          });
        }
      }

      res.json({
        success: true,
        totalMatched: results.matched.length,
        totalUnmatched: results.unmatched.length,
        matched: results.matched,
        unmatched: results.unmatched,
        alreadyAssigned: results.alreadyAssigned,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to rematch audio files');
      res.status(500).json({ error: 'Failed to rematch audio files' });
    }
  });

  // Serve audio file
  /**
   * @openapi
   * /projects/{id}/audio/file/{audioId}:
   *   get:
   *     summary: Stream an audio file's raw bytes.
   *     description: Returns the binary blob with the recorded mime type.
   *     tags: [Audio]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: audioId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Audio bytes.
   *         content:
   *           audio/mpeg:
   *             schema: { type: string, format: binary }
   *       404: { description: Audio file not found. }
   */
  router.get('/file/:audioId', async (req: Request, res: Response) => {
    try {
      const { id, audioId } = req.params;

      const result = await pool.query(
        'SELECT filename, original_name, mime_type FROM audio_files WHERE id = $1 AND project_id = $2',
        [audioId, id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }

      const { filename, original_name, mime_type } = result.rows[0];

      // Open the stream first so we don't set audio headers on a 404 JSON response.
      let stream: NodeJS.ReadableStream;
      try {
        stream = await getStorage().downloadStream(audioKey(id, filename));
      } catch (err) {
        req.log.error({ err }, 'Audio file not found in storage');
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }

      // original_name is user-controlled; encode for safe Content-Disposition.
      // - filename= must be ASCII; strip control chars, escape quotes/backslash
      // - filename*= carries the real (utf-8) name per RFC 5987 for clients
      //   that support it.
      const asciiSafe = original_name
        .replace(/[\r\n\t\0]/g, '')
        .replace(/["\\]/g, '_')
        .slice(0, 200);
      const utf8Safe = encodeURIComponent(original_name);
      res.setHeader('Content-Type', mime_type);
      // A file's id outlives any one take (see /:audioId/replace), so the
      // browser must revalidate rather than play a cached old take.
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${asciiSafe}"; filename*=UTF-8''${utf8Safe}`,
      );
      stream.on('error', (err) => {
        req.log.error({ err }, 'Stream error serving audio');
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream audio' });
        else res.destroy();
      });
      stream.pipe(res);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to serve audio file');
      res.status(500).json({ error: 'Failed to serve audio file' });
    }
  });

  return router;
}
