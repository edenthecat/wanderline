import { Router, Request, Response, RequestHandler } from 'express';
import { Pool } from 'pg';
import { rm, unlink } from 'fs/promises';
import { join, resolve, relative } from 'path';
import { mountStoryRoutes } from './projects-story.js';
import { mountSettingsRoutes } from './projects-settings.js';
import { mountExportRoutes } from './projects-export.js';
import { mountPreviewRoutes } from './projects-preview.js';
import { mountBuildRoutes } from './projects-builds.js';
import { mountSnapshotRoutes } from './projects-snapshots.js';
import { BUILDS_DIR } from '../services/build-service.js';
import { validateProject } from '../services/project-validator.js';
import { getStorage, audioKey, buildArtifactKey, isStorageKey } from '../services/storage.js';
import type { RequireOwnerOrAdmin } from '../middleware/auth.js';
import { UPLOAD_DIR } from '../config.js';

export function createProjectsRouter(
  pool: Pool,
  projectAccess: RequestHandler | undefined,
  requireOwnerOrAdmin: RequireOwnerOrAdmin,
  buildEnqueueLimiter?: RequestHandler,
): Router {
  const router = Router();

  // Apply project access check to all routes with :id param
  if (projectAccess) {
    router.use('/:id', projectAccess);
  }

  /**
   * @openapi
   * /projects:
   *   get:
   *     summary: List projects visible to the current user.
   *     description: |
   *       Admins see every project. Editors see projects they own
   *       (via `projects.owner_id`) or where they're a collaborator
   *       in `project_collaborators`.
   *     tags: [Projects]
   *     responses:
   *       200:
   *         description: Projects list.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 projects:
   *                   type: array
   *                   items: { $ref: '#/components/schemas/Project' }
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const user = req.user;

      let result;
      // expose source_language on the list card so users can
      // tell Ink vs Twee projects apart without opening each one.
      // COALESCE to 'ink' for earlier rows so the badge always has
      // a value.
      if (user?.role === 'admin') {
        // Admins see all projects
        result = await pool.query(`
          SELECT p.*,
                 ps.story_graph IS NOT NULL as has_story,
                 (ps.story_graph->>'title') as story_title,
                 COALESCE(ps.source_language, 'ink') AS source_language
          FROM projects p
          LEFT JOIN project_stories ps ON p.id = ps.project_id
          ORDER BY p.updated_at DESC
        `);
      } else {
        // Editors see only projects they own or collaborate on
        result = await pool.query(
          `
          SELECT p.*,
                 ps.story_graph IS NOT NULL as has_story,
                 (ps.story_graph->>'title') as story_title,
                 COALESCE(ps.source_language, 'ink') AS source_language
          FROM projects p
          LEFT JOIN project_stories ps ON p.id = ps.project_id
          INNER JOIN project_collaborators pc ON p.id = pc.project_id AND pc.user_id = $1
          ORDER BY p.updated_at DESC
        `,
          [user?.id],
        );
      }

      res.json({ projects: result.rows });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to list projects');
      res.status(500).json({ error: 'Failed to list projects' });
    }
  });

  /**
   * @openapi
   * /projects/{id}:
   *   get:
   *     summary: Get a project (with story + settings inlined).
   *     tags: [Projects]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Project detail.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 project:
   *                   allOf:
   *                     - $ref: '#/components/schemas/Project'
   *                     - type: object
   *                       properties:
   *                         story_graph: { type: object, nullable: true }
   *                         ink_source: { type: string, nullable: true }
   *                         settings: { type: object, nullable: true }
   *       404: { description: Project not found. }
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      // also project twee_source + source_language so the
      // frontend can render the right vocab (via nomenclature skin)
      // and swap the source editor to Twee mode when
      // source_language='twee'. COALESCE ensures earlier rows
      // without the columns still report 'ink' rather than null.
      const result = await pool.query(
        `
        SELECT p.*,
               ps.story_graph,
               ps.ink_source,
               ps.twee_source,
               COALESCE(ps.source_language, 'ink') AS source_language,
               pset.settings
        FROM projects p
        LEFT JOIN project_stories ps ON p.id = ps.project_id
        LEFT JOIN project_settings pset ON p.id = pset.project_id
        WHERE p.id = $1
      `,
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      res.json({ project: result.rows[0] });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get project');
      res.status(500).json({ error: 'Failed to get project' });
    }
  });

  /**
   * @openapi
   * /projects:
   *   post:
   *     summary: Create a project.
   *     description: |
   *       The creator becomes `owner_id` and a default
   *       `project_settings` row is created in the same transaction.
   *     tags: [Projects]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name]
   *             properties:
   *               name: { type: string }
   *               description: { type: string, nullable: true }
   *     responses:
   *       201:
   *         description: Created.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 project: { $ref: '#/components/schemas/Project' }
   *       400: { description: Missing / invalid name. }
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { name, description } = req.body;

      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Project name is required' });
        return;
      }

      const userId = req.user?.id;
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const result = await client.query(
          `
          INSERT INTO projects (name, description, owner_id)
          VALUES ($1, $2, $3)
          RETURNING *
        `,
          [name.trim(), description?.trim() || null, userId || null],
        );

        const projectId = result.rows[0].id;

        // Create default settings
        await client.query(
          `
          INSERT INTO project_settings (project_id, settings)
          VALUES ($1, $2)
        `,
          [
            projectId,
            JSON.stringify({
              controls: {
                playPause: 'play_pause',
                nextTrack: 'next_choice',
                previousTrack: 'previous_choice',
              },
              audioDefaults: {
                autoPlay: true,
                crossfadeDuration: 500,
                volume: 1,
              },
            }),
          ],
        );

        // Add creator as project owner
        if (userId) {
          await client.query(
            `
            INSERT INTO project_collaborators (project_id, user_id, role)
            VALUES ($1, $2, 'owner')
          `,
            [projectId, userId],
          );
        }

        await client.query('COMMIT');
        res.status(201).json({ project: result.rows[0] });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      req.log.error({ err: error }, 'Failed to create project');
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  /**
   * @openapi
   * /projects/{id}:
   *   patch:
   *     summary: Update project name / description.
   *     tags: [Projects]
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
   *               name: { type: string }
   *               description: { type: string, nullable: true }
   *     responses:
   *       200:
   *         description: Updated.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 project: { $ref: '#/components/schemas/Project' }
   *       404: { description: Project not found. }
   */
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { name, description } = req.body;

      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(name.trim());
      }
      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        values.push(description?.trim() || null);
      }

      if (updates.length === 0) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }

      values.push(id);
      const result = await pool.query(
        `
        UPDATE projects SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `,
        values,
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      res.json({ project: result.rows[0] });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update project');
      res.status(500).json({ error: 'Failed to update project' });
    }
  });

  // Delete a project
  /**
   * @openapi
   * /projects/{id}:
   *   delete:
   *     summary: Delete a project and all its artifacts.
   *     description: |
   *       Cascades through project_stories, project_settings,
   *       characters, audio_files, node_audio_assignments,
   *       node_metadata, project_collaborators, project_builds. Also
   *       removes audio files from durable storage and any
   *       still-on-disk build artifacts.
   *     tags: [Projects]
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
   *                 success: { type: boolean }
   *       404: { description: Project not found. }
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!(await requireOwnerOrAdmin(req, res, id))) return;

      // Snapshot related rows before deletion — the cascade removes them and
      // we need the filenames to clean up storage objects afterward.
      const buildsResult = await pool.query(
        'SELECT id, artifact_path FROM project_builds WHERE project_id = $1',
        [id],
      );
      const audioResult = await pool.query(
        'SELECT filename FROM audio_files WHERE project_id = $1',
        [id],
      );

      const result = await pool.query(
        `
        DELETE FROM projects WHERE id = $1 RETURNING id
      `,
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Clean up build artifacts and any local temp dirs.
      // artifact_path is a storage key (e.g. "builds/<buildId>.zip") for new
      // builds. Older rows may contain absolute local paths from before the
      // GCS migration — handle those by unlinking from disk if they're inside
      // BUILDS_DIR.
      const storage = getStorage();
      for (const row of buildsResult.rows) {
        const artifactPath: string | null = row.artifact_path;
        if (artifactPath && isStorageKey(artifactPath)) {
          storage.delete(artifactPath).catch((err) => {
            req.log.warn({ err, artifactPath }, 'Failed to delete build artifact');
          });
        } else if (artifactPath) {
          // Legacy local path — unlink only if it's inside BUILDS_DIR
          const rel = relative(resolve(BUILDS_DIR), resolve(artifactPath));
          if (!rel.startsWith('..') && resolve(artifactPath) !== resolve(BUILDS_DIR)) {
            unlink(artifactPath).catch((err) => {
              if (err.code !== 'ENOENT')
                req.log.warn({ err, artifactPath }, 'Failed to delete legacy artifact');
            });
          } else {
            req.log.warn({ artifactPath }, 'Skipping legacy artifact outside BUILDS_DIR');
          }
        }
        // Always try the new-format storage key in case it was stored differently
        storage.delete(buildArtifactKey(row.id)).catch(() => {});
        // Clean up any local temp build dir leftover from in-progress builds
        rm(join(BUILDS_DIR, `build_${row.id}`), { recursive: true, force: true }).catch(() => {});
      }

      // Clean up audio objects in storage. The cascade has already dropped
      // the DB rows, so we use the snapshot taken before deletion.
      for (const row of audioResult.rows) {
        storage.delete(audioKey(id, row.filename)).catch((err) => {
          req.log.warn({ err, filename: row.filename }, 'Failed to delete audio object');
        });
      }

      // Audio uploads land in UPLOAD_DIR/<projectId>/ on local disk before
      // being pushed to storage; if any are mid-flight (or this deployment
      // is using local-only storage) the directory still holds files.
      // Drop the whole project-scoped dir. The defense-in-depth guard
      // matters even though req.params.id has already round-tripped a UUID
      // column above: if the rm call ever moves above the SELECT/DELETE,
      // or the schema changes, `id` of '.' or '..' would otherwise wipe
      // UPLOAD_DIR's parent.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (UUID_RE.test(id)) {
        const targetDir = resolve(UPLOAD_DIR, id);
        const rel = relative(resolve(UPLOAD_DIR), targetDir);
        if (!rel.startsWith('..') && targetDir !== resolve(UPLOAD_DIR)) {
          rm(targetDir, { recursive: true, force: true }).catch((err) => {
            req.log.warn({ err, projectId: id }, 'Failed to remove project upload dir');
          });
        }
      }

      res.json({ success: true, deleted: id });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to delete project');
      res.status(500).json({ error: 'Failed to delete project' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/validate:
   *   get:
   *     summary: Pre-build validation report.
   *     description: |
   *       Cheap (no actual build runs). Surfaces parser errors, missing
   *       audio assignments, orphaned files, and indicator-audio breakage
   *       in one report so authors can green-light a build before paying
   *       the minutes of a full one.
   *     tags: [Projects]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Validation report.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 report: { $ref: '#/components/schemas/ProjectValidationReport' }
   *       404: { description: Project not found. }
   */
  // cheap pre-build validation. Surfaces story-parser errors,
  // unreachable audio assignments, and orphaned files in one report so
  // authors can green-light a build without actually running one.
  router.get('/:id/validate', async (req: Request, res: Response) => {
    try {
      const report = await validateProject(pool, req.params.id);
      res.json({ report });
    } catch (error: unknown) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      if (status === 404) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      req.log.error({ err: error }, 'Failed to validate project');
      res.status(500).json({ error: 'Failed to validate project' });
    }
  });

  // Delegate to sub-routers
  mountStoryRoutes(router, pool);
  mountSettingsRoutes(router, pool);
  mountExportRoutes(router, pool);
  mountPreviewRoutes(router, pool);
  mountBuildRoutes(router, pool, { postLimiter: buildEnqueueLimiter });
  mountSnapshotRoutes(router, pool);

  return router;
}
