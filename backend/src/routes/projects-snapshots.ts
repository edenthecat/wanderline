// Version-history routes. A project_snapshot captures the
// editable parts of a project (story_graph, ink source, per-node
// metadata) so a user can roll back from a destructive change.
//
// Restore semantics: write the snapshotted payload back into the
// project's primary rows in a single transaction, then drop the
// live collab room so any connected editors reconnect against
// the new state (y-websocket auto-reconnects).
//
// Auto-capture: routes that ARE destructive (ink reupload,
// snapshot restore itself) call `captureSnapshot` with
// source='auto' before they touch the project. That way the user
// can always roll back to "the state right before whatever I just
// did".

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { invalidateRoom, flushPendingShadowSave } from '../services/collab-server.js';

interface CaptureInput {
  pool: Pool;
  projectId: string;
  label: string;
  source: 'manual' | 'auto';
  createdBy: string | null;
}

/**
 * Read the current project state and persist it as a new
 * project_snapshots row. Exported so other route modules
 * (ink upload, etc.) can pre-snapshot before destructive writes.
 */
export async function captureSnapshot({
  pool,
  projectId,
  label,
  source,
  createdBy,
}: CaptureInput): Promise<{ id: string; createdAt: string }> {
  // Force any in-flight collab shadow saver to flush BEFORE we read
  // the row, otherwise edits sitting in the debounce window (worst
  // case: ~2s) would be missed by this snapshot. Resolves a no-op
  // when no collab room is live. We intentionally let any flush
  // error propagate — capturing a snapshot that's missing recent
  // edits silently is worse than failing the snapshot request and
  // letting the user retry.
  await flushPendingShadowSave(projectId);
  // Read story_graph + ink_source + the per-node metadata rows.
  // Inline the metadata so a restore doesn't depend on the
  // node_metadata rows still existing (a delete-all could have
  // wiped them between snapshot and restore).
  const result = await pool.query(
    `
    SELECT ps.story_graph,
           ps.ink_source,
           COALESCE(
             (SELECT jsonb_object_agg(
                node_id,
                to_jsonb(nm)
                  - 'node_id'
                  - 'project_id'
                  -- Strip identity + audit columns so restore re-generates
                  -- a fresh PK and CURRENT_TIMESTAMP for created_at /
                  -- updated_at. Capturing them would make restored rows
                  -- look untouched and demote the project in 'recent'
                  -- sorts; PK reuse would also break ON DELETE CASCADE
                  -- expectations if the row ever changed parent.
                  - 'id'
                  - 'created_at'
                  - 'updated_at'
              )
              FROM node_metadata nm
              WHERE nm.project_id = $1),
             '{}'::jsonb
           ) AS node_metadata
    FROM project_stories ps
    WHERE ps.project_id = $1
    `,
    [projectId],
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error('Project has no story to snapshot'), { statusCode: 400 });
  }
  const { story_graph, ink_source, node_metadata } = result.rows[0];
  const insert = await pool.query(
    `INSERT INTO project_snapshots (project_id, created_by, label, source, story_graph, ink_source, node_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [projectId, createdBy, label, source, story_graph, ink_source, node_metadata],
  );
  return { id: insert.rows[0].id, createdAt: insert.rows[0].created_at };
}

export function mountSnapshotRoutes(router: Router, pool: Pool): void {
  /**
   * @openapi
   * /projects/{id}/snapshots:
   *   get:
   *     summary: List a project's snapshots, newest first.
   *     tags: [Snapshots]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Snapshots.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 snapshots:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string, format: uuid }
   *                       label: { type: string }
   *                       source: { type: string, enum: [manual, auto] }
   *                       createdAt: { type: string, format: date-time }
   *                       createdBy: { type: string, format: uuid, nullable: true }
   *                       createdByName: { type: string, nullable: true }
   */
  router.get('/:id/snapshots', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `SELECT s.id, s.label, s.source, s.created_at,
                s.created_by,
                u.display_name AS created_by_name
         FROM project_snapshots s
         LEFT JOIN users u ON u.id = s.created_by
         WHERE s.project_id = $1
         ORDER BY s.created_at DESC
         LIMIT 200`,
        [id],
      );
      res.json({ snapshots: result.rows });
    } catch (err) {
      req.log.error({ err }, 'Failed to list snapshots');
      res.status(500).json({ error: 'Failed to list snapshots' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/snapshots:
   *   post:
   *     summary: Capture the current state as a manual snapshot.
   *     tags: [Snapshots]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               label: { type: string, maxLength: 200 }
   *     responses:
   *       201:
   *         description: Snapshot captured.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 snapshot:
   *                   type: object
   *                   properties:
   *                     id: { type: string, format: uuid }
   *                     label: { type: string }
   *                     source: { type: string, enum: [manual, auto] }
   *                     createdAt: { type: string, format: date-time }
   *       404: { description: Project not found. }
   */
  router.post('/:id/snapshots', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userId = req.session?.userId ?? null;
      const rawLabel = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
      const label = rawLabel.length > 0 ? rawLabel.slice(0, 200) : 'Manual snapshot';
      const out = await captureSnapshot({
        pool,
        projectId: id,
        label,
        source: 'manual',
        createdBy: userId,
      });
      res.status(201).json(out);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      req.log.error({ err }, 'Failed to create snapshot');
      res.status(status).json({
        error: err instanceof Error ? err.message : 'Failed to create snapshot',
      });
    }
  });

  /**
   * @openapi
   * /projects/{id}/snapshots/{snapshotId}/restore:
   *   post:
   *     summary: Roll the project back to the snapshot.
   *     description: |
   *       Writes a fresh `auto` snapshot of the current state first
   *       (so the restore itself is reversible), then transactionally
   *       replaces story_graph / ink_source / node_metadata with the
   *       snapshot, then drops the live collab room so connected
   *       editors reconnect against the restored row.
   *     tags: [Snapshots]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: snapshotId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Restored.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *       404: { description: Snapshot not found for this project. }
   */
  router.post('/:id/snapshots/:snapshotId/restore', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const { id, snapshotId } = req.params;
      const userId = req.session?.userId ?? null;

      // Fail fast if the snapshot doesn't exist before we open a tx.
      const snap = await client.query(
        `SELECT story_graph, ink_source, node_metadata
         FROM project_snapshots
         WHERE id = $1 AND project_id = $2`,
        [snapshotId, id],
      );
      if (snap.rows.length === 0) {
        res.status(404).json({ error: 'Snapshot not found' });
        return;
      }

      // Capture pre-restore state as an `auto` snapshot. Done
      // OUTSIDE the tx so a failed restore still leaves the safety
      // net behind.
      await captureSnapshot({
        pool,
        projectId: id,
        label: 'Before restore',
        source: 'auto',
        createdBy: userId,
      });

      await client.query('BEGIN');
      await client.query(
        `UPDATE project_stories
         SET story_graph = $2,
             ink_source = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $1`,
        [id, snap.rows[0].story_graph, snap.rows[0].ink_source],
      );
      // Bump the project's own updated_at so project lists / recency
      // sorts treat a restore the same as a manual edit.
      await client.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
      // Replace node_metadata. We delete-then-insert rather than
      // upsert so node ids removed in the snapshot disappear.
      await client.query('DELETE FROM node_metadata WHERE project_id = $1', [id]);
      const metadataMap = snap.rows[0].node_metadata as Record<string, Record<string, unknown>>;
      // Use jsonb_populate_record so the INSERT picks columns from the
      // node_metadata row type itself rather than a hardcoded list.
      // If a future migration adds a column to node_metadata, the
      // snapshot's to_jsonb captured it and this loop will restore
      // it without any code change here — preventing silent drop of
      // newly-added metadata fields on restore.
      for (const [nodeId, fields] of Object.entries(metadataMap)) {
        // Strip identity + audit columns at restore time as a
        // defensive layer in case any older snapshot was captured
        // before captureSnapshot started filtering these out.
        // Otherwise jsonb_populate_record would write a stale id
        // (PK reuse) or a pre-snapshot updated_at (breaking
        // "recently edited" sorts).
        const {
          id: _ignoredId,
          created_at: _ignoredCreatedAt,
          updated_at: _ignoredUpdatedAt,
          ...cleaned
        } = fields as Record<string, unknown>;
        void _ignoredId;
        void _ignoredCreatedAt;
        void _ignoredUpdatedAt;
        const merged = { ...cleaned, project_id: id, node_id: nodeId };
        await client.query(
          `INSERT INTO node_metadata
             SELECT (jsonb_populate_record(NULL::node_metadata, $1::jsonb)).*`,
          [JSON.stringify(merged)],
        );
      }
      await client.query('COMMIT');

      // Kick connected editors so they reconnect against the
      // restored row instead of editing the now-stale in-memory
      // Y.Doc. Awaited so any in-flight shadow-save settles BEFORE
      // we respond — without the await a trailing UPDATE could
      // land after this handler returns and revert the restore.
      await invalidateRoom(id);

      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      req.log.error({ err }, 'Failed to restore snapshot');
      res.status(500).json({ error: 'Failed to restore snapshot' });
    } finally {
      client.release();
    }
  });

  /**
   * @openapi
   * /projects/{id}/snapshots/{snapshotId}:
   *   delete:
   *     summary: Delete a snapshot.
   *     tags: [Snapshots]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: snapshotId
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
   *       404: { description: Snapshot not found for this project. }
   */
  router.delete('/:id/snapshots/:snapshotId', async (req: Request, res: Response) => {
    try {
      const { id, snapshotId } = req.params;
      const result = await pool.query(
        `DELETE FROM project_snapshots
         WHERE id = $1 AND project_id = $2`,
        [snapshotId, id],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: 'Snapshot not found' });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      req.log.error({ err }, 'Failed to delete snapshot');
      res.status(500).json({ error: 'Failed to delete snapshot' });
    }
  });
}
