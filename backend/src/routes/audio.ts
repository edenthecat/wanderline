import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { mkdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  triggerTranscription,
  retryTranscription,
  getTranscriptionStatus,
  getWhisperModelStatus,
} from '../services/transcription.js';
import { getStorage, audioKey } from '../services/storage.js';
import { buildMatchTables, matchAudioFile } from '../services/audio-matcher.js';

const execAsync = promisify(exec);

// Convert WAV to MP3 using ffmpeg
async function convertWavToMp3(inputPath: string, outputPath: string): Promise<void> {
  // Use high quality MP3 encoding: -q:a 2 is roughly equivalent to 192kbps VBR
  await execAsync(`ffmpeg -i "${inputPath}" -codec:a libmp3lame -q:a 2 "${outputPath}" -y`);
  // Remove the original WAV file
  await unlink(inputPath);
}

// Configure multer for audio file uploads
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/wanderline-uploads';

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
            'Converted WAV to MP3',
          );
        } catch (err) {
          req.log.error({ err }, 'Failed to convert WAV to MP3');
          // Continue with original file if conversion fails
        }
      }

      // Persist to durable storage (GCS in prod, local FS in dev). Fail the
      // request if storage is misconfigured/unavailable rather than insert a
      // DB row that points at a missing object — that would 404 forever on
      // download.
      const localPath = join(UPLOAD_DIR, id, finalFilename);
      try {
        await getStorage().uploadFile(audioKey(id, finalFilename), localPath, finalMimeType);
      } catch (err) {
        req.log.error({ err }, 'Failed to persist audio to storage');
        // Clean up the local copy so we don't leak files
        try {
          await unlink(localPath);
        } catch {
          /* may not exist */
        }
        res.status(503).json({ error: 'Failed to persist audio to durable storage' });
        return;
      }

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

      // Delete from database (cascades to assignments)
      await pool.query('DELETE FROM audio_files WHERE id = $1', [audioId]);

      // Delete from durable storage and any local copy
      const filename = fileResult.rows[0].filename;
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
        { voiceover?: string; ambience?: string; choice1?: string; choice2?: string; sfx: string[] }
      > = {};
      for (const row of result.rows) {
        if (!assignments[row.node_id]) {
          assignments[row.node_id] = { sfx: [] };
        }
        if (row.audio_type === 'sfx') {
          assignments[row.node_id].sfx.push(row.audio_file_id);
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
   *               audioType: { type: string, enum: [voiceover, ambience, choice1, choice2] }
   *               audioFileId: { type: string, format: uuid }
   *     responses:
   *       200: { description: Assigned. }
   *       400: { description: Missing / invalid fields. }
   */
  router.post('/assignments', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, audioType, audioFileId } = req.body;

      if (!nodeId || !audioType || !audioFileId) {
        res.status(400).json({ error: 'nodeId, audioType, and audioFileId are required' });
        return;
      }

      if (!['voiceover', 'ambience', 'sfx', 'choice1', 'choice2'].includes(audioType)) {
        res
          .status(400)
          .json({ error: 'audioType must be voiceover, ambience, sfx, choice1, or choice2' });
        return;
      }

      // For voiceover, ambience, choice1, choice2 - replace existing assignment (sfx can have multiple)
      if (audioType !== 'sfx') {
        await pool.query(
          `
          DELETE FROM node_audio_assignments
          WHERE project_id = $1 AND node_id = $2 AND audio_type = $3
        `,
          [id, nodeId, audioType],
        );
      }

      const result = await pool.query(
        `
        INSERT INTO node_audio_assignments (project_id, node_id, audio_type, audio_file_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (project_id, node_id, audio_type, audio_file_id) DO NOTHING
        RETURNING *
      `,
        [id, nodeId, audioType, audioFileId],
      );

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      // Trigger transcription for voiceover assignments (runs in background)
      if (audioType === 'voiceover') {
        triggerTranscription(pool, audioFileId, id);
      }

      res.status(201).json({ assignment: result.rows[0] || { nodeId, audioType, audioFileId } });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to assign audio');
      res.status(500).json({ error: 'Failed to assign audio' });
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
   *       400: { description: Bad op (missing/invalid fields, unknown file, no matching assignment). }
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

      let swapped = 0;
      const transcriptionTargets: string[] = [];
      for (const op of ops) {
        const del = await client.query(
          `DELETE FROM node_audio_assignments
           WHERE project_id = $1 AND node_id = $2 AND audio_type = $3 AND audio_file_id = $4
           RETURNING id`,
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
        await client.query(
          `INSERT INTO node_audio_assignments (project_id, node_id, audio_type, audio_file_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id, node_id, audio_type, audio_file_id) DO NOTHING`,
          [id, op.nodeId, op.audioType, op.toFileId],
        );
        swapped += 1;
        if (op.audioType === 'voiceover') {
          transcriptionTargets.push(op.toFileId);
        }
      }

      await client.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
      await client.query('COMMIT');

      // Transcription is best-effort, runs in the background after the
      // tx commits so a failure there doesn't roll back the swap.
      // Critically: only kick off transcription for target files that
      // don't already have one. triggerTranscription unconditionally
      // sets status='processing' and re-runs whisper, which would
      // wipe a completed transcription and burn CPU on every swap.
      if (transcriptionTargets.length > 0) {
        const uniqueTargets = Array.from(new Set(transcriptionTargets));
        const statusRes = await pool.query<{ id: string; transcription_status: string | null }>(
          `SELECT id, transcription_status FROM audio_files WHERE id = ANY($1::uuid[])`,
          [uniqueTargets],
        );
        const needsTranscription = (status: string | null) =>
          status === null || status === 'pending' || status === 'failed';
        for (const row of statusRes.rows) {
          if (needsTranscription(row.transcription_status)) {
            triggerTranscription(pool, row.id, id);
          }
        }
      }

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

  // Get transcription status for an audio file
  router.get('/transcription/:audioId', async (req: Request, res: Response) => {
    try {
      const { audioId } = req.params;

      const status = await getTranscriptionStatus(pool, audioId);

      if (!status) {
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }

      res.json(status);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get transcription status');
      res.status(500).json({ error: 'Failed to get transcription status' });
    }
  });

  // Retry transcription for an audio file
  router.post('/transcription/:audioId/retry', async (req: Request, res: Response) => {
    try {
      const { id, audioId } = req.params;

      const result = await retryTranscription(pool, audioId, id);

      if (result.success) {
        res.json({ success: true, transcription: result.transcription });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error) {
      req.log.error({ err: error }, 'Failed to retry transcription');
      res.status(500).json({ error: 'Failed to retry transcription' });
    }
  });

  // Get all transcriptions for a project (for diff export)
  router.get('/transcriptions', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `
        SELECT
          af.id,
          af.original_name,
          af.transcription,
          af.transcription_status,
          af.transcription_error,
          naa.node_id,
          naa.audio_type
        FROM audio_files af
        LEFT JOIN node_audio_assignments naa ON af.id = naa.audio_file_id
        WHERE af.project_id = $1
        ORDER BY naa.node_id
      `,
        [id],
      );

      res.json({ transcriptions: result.rows });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get transcriptions');
      res.status(500).json({ error: 'Failed to get transcriptions' });
    }
  });

  // Get transcription progress for project
  router.get('/transcription-progress', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE transcription_status = 'completed') as completed,
          COUNT(*) FILTER (WHERE transcription_status = 'processing') as processing,
          COUNT(*) FILTER (WHERE transcription_status = 'pending' OR transcription_status IS NULL) as pending,
          COUNT(*) FILTER (WHERE transcription_status = 'failed') as failed
        FROM audio_files
        WHERE project_id = $1
      `,
        [id],
      );

      const stats = result.rows[0];
      const total = parseInt(stats.total);
      const completed = parseInt(stats.completed);
      const processing = parseInt(stats.processing);
      const pending = parseInt(stats.pending);
      const failed = parseInt(stats.failed);

      res.json({
        total,
        completed,
        processing,
        pending,
        failed,
        percent: total > 0 ? Math.round((completed / total) * 100) : 0,
        isRunning: processing > 0,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get transcription progress');
      res.status(500).json({ error: 'Failed to get transcription progress' });
    }
  });

  // Trigger transcription for all audio files in project
  router.post('/transcribe-all', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Get all audio files that haven't been transcribed yet
      const result = await pool.query(
        `
        SELECT id FROM audio_files
        WHERE project_id = $1
        AND (transcription_status IS NULL OR transcription_status IN ('pending', 'failed'))
      `,
        [id],
      );

      const audioIds = result.rows.map((r) => r.id);

      if (audioIds.length === 0) {
        res.json({ message: 'No audio files need transcription', queued: 0 });
        return;
      }

      // Trigger transcription for each file (runs in background)
      for (const audioId of audioIds) {
        triggerTranscription(pool, audioId, id);
      }

      res.json({
        message: `Queued ${audioIds.length} audio files for transcription`,
        queued: audioIds.length,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to trigger transcriptions');
      res.status(500).json({ error: 'Failed to trigger transcriptions' });
    }
  });

  // Get Whisper model status (download progress)
  router.get('/whisper-status', async (req: Request, res: Response) => {
    try {
      const status = getWhisperModelStatus();
      res.json(status);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get whisper status');
      res.status(500).json({ error: 'Failed to get whisper status' });
    }
  });

  // Clear all transcriptions for a project
  router.post('/clear-transcriptions', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `
        UPDATE audio_files
        SET transcription = NULL, transcription_status = 'pending', transcription_error = NULL
        WHERE project_id = $1
      `,
        [id],
      );

      res.json({
        message: `Cleared transcriptions for ${result.rowCount} audio files`,
        cleared: result.rowCount,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to clear transcriptions');
      res.status(500).json({ error: 'Failed to clear transcriptions' });
    }
  });

  return router;
}
