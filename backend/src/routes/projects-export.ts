import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import archiver from 'archiver';
import { createReadStream, existsSync } from 'fs';
import { join } from 'path';
import { convertStoryGraphToInk as convertStoryGraphToInkService } from '../services/ink-converter.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/wanderline-uploads';

export function mountExportRoutes(router: Router, pool: Pool): void {
  /**
   * @openapi
   * /projects/{id}/export:
   *   get:
   *     summary: Export a project as a .wanderline archive.
   *     description: |
   *       Streams a zip containing the Ink source, story_graph,
   *       project settings, character roster, node_metadata, audio
   *       files, and node_audio_assignments. Round-trippable via
   *       admin import (not yet exposed).
   *     tags: [Export]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Zip stream.
   *         content:
   *           application/zip:
   *             schema: { type: string, format: binary }
   *       404: { description: Project not found. }
   */
  router.get('/:id/export', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Get all project data
      const projectResult = await pool.query(
        `
        SELECT p.*,
               ps.story_graph,
               ps.ink_source,
               pset.settings
        FROM projects p
        LEFT JOIN project_stories ps ON p.id = ps.project_id
        LEFT JOIN project_settings pset ON p.id = pset.project_id
        WHERE p.id = $1
      `,
        [id],
      );

      if (projectResult.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const project = projectResult.rows[0];

      // Get audio files
      const audioResult = await pool.query('SELECT * FROM audio_files WHERE project_id = $1', [id]);

      // Get audio assignments
      const assignmentsResult = await pool.query(
        'SELECT * FROM node_audio_assignments WHERE project_id = $1',
        [id],
      );

      // Get node metadata
      const metadataResult = await pool.query('SELECT * FROM node_metadata WHERE project_id = $1', [
        id,
      ]);

      // Create archive
      const archive = archiver('zip', { zlib: { level: 9 } });
      const filename = `${project.name.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.zip`;

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      archive.on('error', (err) => {
        req.log.error({ err }, 'Archive error during export');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to create archive' });
        }
      });

      archive.pipe(res);

      // Add manifest
      const manifest = {
        version: '1.0',
        exportDate: new Date().toISOString(),
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          created_at: project.created_at,
          updated_at: project.updated_at,
        },
        settings: project.settings,
        storyGraph: project.story_graph,
        inkSource: project.ink_source,
        audioFiles: audioResult.rows.map((f) => ({
          id: f.id,
          filename: f.filename,
          original_name: f.original_name,
          mime_type: f.mime_type,
          size_bytes: f.size_bytes,
        })),
        audioAssignments: assignmentsResult.rows,
        nodeMetadata: metadataResult.rows,
      };

      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

      // Add audio files
      const projectAudioDir = join(UPLOAD_DIR, id);
      let missingCount = 0;
      for (const file of audioResult.rows) {
        const filePath = join(projectAudioDir, file.filename);
        if (existsSync(filePath)) {
          archive.append(createReadStream(filePath), { name: `audio/${file.filename}` });
        } else {
          missingCount++;
        }
      }

      if (missingCount > 0) {
        req.log.warn(
          { missingCount, totalCount: audioResult.rows.length },
          'Export warning: some audio files are missing from uploads',
        );
      }

      await archive.finalize();
    } catch (error) {
      req.log.error({ err: error }, 'Failed to export project');
      res.status(500).json({ error: 'Failed to export project' });
    }
  });

  // Export project as Ink file
  /**
   * @openapi
   * /projects/{id}/export-ink:
   *   get:
   *     summary: Download the project's .ink source.
   *     description: |
   *       Reconstitutes the Ink source from the stored copy (or, if
   *       absent, regenerates one from story_graph).
   *     tags: [Export]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Ink source.
   *         content:
   *           text/plain:
   *             schema: { type: string }
   *       404: { description: Project not found. }
   */
  router.get('/:id/export-ink', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Get project with story graph
      const projectResult = await pool.query(
        `
        SELECT p.name, ps.story_graph
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

      const { name: projectName, story_graph: storyGraph } = projectResult.rows[0];

      if (!storyGraph) {
        res.status(400).json({ error: 'Project has no story uploaded' });
        return;
      }

      // Convert story graph to Ink format
      const inkContent = convertStoryGraphToInkService(storyGraph);

      const filename = `${projectName.replace(/[^a-z0-9]/gi, '_')}.ink`;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(inkContent);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to export Ink file');
      res.status(500).json({ error: 'Failed to export Ink file' });
    }
  });

  // Export project story graph as JSON
  /**
   * @openapi
   * /projects/{id}/export-json:
   *   get:
   *     summary: Download the full story payload as JSON.
   *     description: |
   *       The exact payload the player consumes — story_graph plus
   *       resolved per-node audio paths, settings, characters, metadata.
   *     tags: [Export]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Story JSON.
   *         content:
   *           application/json:
   *             schema: { type: object }
   *       404: { description: Project not found. }
   */
  router.get('/:id/export-json', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Get project with story graph
      const projectResult = await pool.query(
        `
        SELECT p.name, ps.story_graph
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

      const { name: projectName, story_graph: storyGraph } = projectResult.rows[0];

      if (!storyGraph) {
        res.status(400).json({ error: 'Project has no story uploaded' });
        return;
      }

      const filename = `${projectName.replace(/[^a-z0-9]/gi, '_')}.json`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(JSON.stringify(storyGraph, null, 2));
    } catch (error) {
      req.log.error({ err: error }, 'Failed to export JSON file');
      res.status(500).json({ error: 'Failed to export JSON file' });
    }
  });
}
