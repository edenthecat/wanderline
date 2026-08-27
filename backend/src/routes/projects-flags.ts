import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

// Flags raised against a passage while reviewing the story.
//
// Reviewing means listening, and the moment you notice something wrong
// is while it's playing — not later, back in the editor, trying to
// remember which passage it was. So flags are raised from the preview
// and surface on the passage itself in the story list and the graph.

/** Closed set so the editor and the graph can render each consistently. */
const REASONS = new Set(['not_working', 'incorrect_audio', 'needs_text_edit']);

// A note is optional context, not an essay. Capped so a paste accident
// can't put a megabyte of text behind a badge in the node list.
const MAX_NOTE_LENGTH = 2000;

export function mountFlagRoutes(router: Router, pool: Pool): void {
  /**
   * @openapi
   * /projects/{id}/flags:
   *   get:
   *     summary: Flags raised against this project's passages.
   *     description: |
   *       Open flags by default. Pass `?include=resolved` for the full
   *       history — a flag that was raised and dealt with is useful
   *       when the same passage is questioned again.
   *     tags: [Projects]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200: { description: 'Flags, newest first.' }
   */
  router.get('/:id/flags', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const includeResolved = req.query.include === 'resolved';
      const result = await pool.query(
        `SELECT f.id, f.node_id, f.reason, f.note, f.created_at, f.resolved_at,
                u.display_name AS created_by_name
           FROM node_flags f
           LEFT JOIN users u ON u.id = f.created_by
          WHERE f.project_id = $1
            ${includeResolved ? '' : 'AND f.resolved_at IS NULL'}
          ORDER BY f.created_at DESC`,
        [id],
      );
      res.json({
        flags: result.rows.map((r) => ({
          id: r.id,
          nodeId: r.node_id,
          reason: r.reason,
          note: r.note,
          createdAt: r.created_at,
          resolvedAt: r.resolved_at,
          createdByName: r.created_by_name,
        })),
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to list node flags');
      res.status(500).json({ error: 'Failed to list flags' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/flags:
   *   post:
   *     summary: Flag a passage.
   *     tags: [Projects]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       201: { description: Flag raised. }
   *       400: { description: Missing nodeId or unknown reason. }
   */
  router.post('/:id/flags', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { nodeId, reason, note } = req.body ?? {};
      if (!nodeId || typeof nodeId !== 'string') {
        res.status(400).json({ error: 'nodeId is required' });
        return;
      }
      if (!REASONS.has(reason)) {
        res.status(400).json({ error: `reason must be one of: ${[...REASONS].join(', ')}` });
        return;
      }
      if (note != null && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
        res
          .status(400)
          .json({ error: `note must be a string under ${MAX_NOTE_LENGTH} characters` });
        return;
      }
      // Deliberately NOT validated against the story graph. A passage
      // can be renamed or removed between a reviewer hearing the
      // problem and the flag landing, and losing the report because the
      // id moved is worse than holding a flag that points nowhere —
      // the editor shows those as orphaned rather than hiding them.
      const result = await pool.query(
        `INSERT INTO node_flags (project_id, node_id, reason, note, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, node_id, reason, note, created_at`,
        [id, nodeId, reason, note ?? null, req.user?.id ?? null],
      );
      const row = result.rows[0];
      res.status(201).json({
        flag: {
          id: row.id,
          nodeId: row.node_id,
          reason: row.reason,
          note: row.note,
          createdAt: row.created_at,
          resolvedAt: null,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to create node flag');
      res.status(500).json({ error: 'Failed to raise flag' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/flags/{flagId}/resolve:
   *   post:
   *     summary: Mark a flag dealt with.
   *     description: |
   *       Kept rather than deleted — a flag that was raised and
   *       addressed is useful history when the same passage is
   *       questioned again.
   *     tags: [Projects]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: flagId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200: { description: Resolved. }
   *       404: { description: No such open flag on this project. }
   */
  router.post('/:id/flags/:flagId/resolve', async (req: Request, res: Response) => {
    try {
      const { id, flagId } = req.params;
      // Scoped by project so a flag id from elsewhere can't be resolved
      // through a project the caller does have access to.
      const result = await pool.query(
        `UPDATE node_flags
            SET resolved_at = CURRENT_TIMESTAMP, resolved_by = $3
          WHERE id = $1 AND project_id = $2 AND resolved_at IS NULL
          RETURNING id`,
        [flagId, id, req.user?.id ?? null],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Flag not found or already resolved' });
        return;
      }
      res.json({ resolved: true });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to resolve node flag');
      res.status(500).json({ error: 'Failed to resolve flag' });
    }
  });
}
