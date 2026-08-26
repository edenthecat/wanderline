import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { extname, join } from 'path';
import { unlink } from 'fs/promises';
import { getStorage, iconKey } from '../services/storage.js';
import { UPLOAD_DIR } from '../config.js';

// Icons are small and square; 5MB is generous for a PNG at 1024px and
// well under the 50MB audio ceiling. Anything larger is a photo the
// author meant to crop first.
const MAX_ICON_BYTES = 5 * 1024 * 1024;

// Formats ffmpeg can reliably decode into a PNG. SVG is deliberately
// excluded: ffmpeg can't rasterise it, and accepting a format we'd
// silently fail to convert is worse than rejecting it up front with a
// message the author can act on.
const ALLOWED_ICON_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_ICON_EXT = /\.(png|jpe?g|webp)$/i;

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_ICON_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_ICON_MIME.has(file.mimetype) || ALLOWED_ICON_EXT.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPEG or WebP icons are allowed'));
    }
  },
});

export function mountIconRoutes(router: Router, pool: Pool): void {
  /**
   * @openapi
   * /projects/{id}/icon:
   *   post:
   *     summary: Upload the PWA icon used by generated builds.
   *     description: |
   *       Replaces any existing icon for the project. The stored
   *       filename is recorded at `settings.appIcon.filename`; the
   *       build pipeline resizes it to 192px and 512px and points the
   *       generated manifest at the results.
   *     tags: [Projects]
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
   *               icon:
   *                 type: string
   *                 format: binary
   *     responses:
   *       200: { description: Icon stored. }
   *       400: { description: Missing or unsupported file. }
   */
  router.post('/:id/icon', (req: Request, res: Response) => {
    upload.single('icon')(req, res, async (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : 'Icon upload failed';
        const status = message.includes('File too large') ? 413 : 400;
        res.status(status).json({
          error: message.includes('File too large') ? 'Icon must be 5MB or smaller' : message,
        });
        return;
      }
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No icon file provided' });
        return;
      }

      const projectId = req.params.id;
      // multer's `dest` mode names the temp file with its own random
      // id and no extension; give the stored object a real one so
      // ffmpeg can sniff the format from the path at build time.
      const ext = extname(file.originalname).toLowerCase() || '.png';
      const filename = `${randomUUID()}${ext}`;

      try {
        await getStorage().uploadFile(iconKey(projectId, filename), file.path, file.mimetype);

        // Merge rather than replace so an author who set colours before
        // uploading art doesn't lose them.
        await pool.query(
          `UPDATE project_settings
              SET settings = jsonb_set(
                    COALESCE(settings, '{}'::jsonb),
                    '{appIcon}',
                    COALESCE(settings->'appIcon', '{}'::jsonb) || $2::jsonb,
                    true
                  )
            WHERE project_id = $1`,
          [projectId, JSON.stringify({ filename })],
        );

        res.json({ filename });
      } catch (error) {
        req.log.error({ err: error }, 'Failed to store project icon');
        res.status(500).json({ error: 'Failed to store icon' });
      } finally {
        // The temp upload is always disposable — it's been copied into
        // durable storage or the request failed outright.
        await unlink(join(file.destination, file.filename)).catch(() => undefined);
      }
    });
  });
}
