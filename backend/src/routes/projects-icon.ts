import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import { randomUUID } from 'crypto';
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

// Project ids in the URL are always UUIDs generated server-side. Match
// audio.ts: requireProjectAccess doesn't validate id shape, so an admin
// could push a bare `..` through it, and the id becomes part of the
// storage key below — which the local storage backend resolves to a
// real filesystem path.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extension for the stored object, derived from the type we already
 * validated rather than from the uploaded filename. `extname` can't
 * emit a separator, but taking arbitrary user text into a storage key
 * is how the next bug gets written; the type is a closed set, so use
 * it. Falls back through the filename with the same alphanumeric-only
 * sanitising audio.ts applies.
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function safeIconExtension(mimetype: string, originalname: string): string {
  const byMime = EXT_BY_MIME[mimetype];
  if (byMime) return byMime;
  // Reduce to a basename first, then take the segment after the last
  // dot within it. Going straight for the last dot in the whole string
  // finds the one in "../.." and yields "etcpassw" for
  // "../../etc/passwd" — safe, but nonsense. And split('.').pop() on a
  // name with no dot at all returns the whole name, so "noextension"
  // would become the extension "noextens". Both separators, because an
  // originalname arrives from the client and may be a Windows path.
  const base = originalname.split(/[/\\]/).pop() || '';
  const dot = base.lastIndexOf('.');
  const raw = dot > 0 ? base.slice(dot + 1) : '';
  return (
    raw
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8)
      .toLowerCase() || 'png'
  );
}

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
      if (!UUID_RE.test(projectId)) {
        res.status(400).json({ error: 'Invalid project id' });
        return;
      }
      // multer's `dest` mode names the temp file with its own random
      // id and no extension; give the stored object a real one so
      // ffmpeg can sniff the format from the path at build time.
      const filename = `${randomUUID()}.${safeIconExtension(file.mimetype, file.originalname)}`;

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
        //
        // Use multer's own `file.path` rather than rejoining destination
        // and filename: it's the exact path multer wrote, so there's no
        // way for the two to be recombined into something else, and
        // nothing derived from the request reaches a path expression.
        await unlink(file.path).catch(() => undefined);
      }
    });
  });
}
