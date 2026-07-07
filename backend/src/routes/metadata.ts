import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

export function createMetadataRouter(pool: Pool): Router {
  const router = Router({ mergeParams: true });

  /**
   * @openapi
   * /projects/{id}/metadata:
   *   get:
   *     summary: List per-node metadata for a project.
   *     description: |
   *       Returns the rows from `node_metadata` (transcript override,
   *       timing controls, theme via character). Used by StoryTab to
   *       pre-populate per-node editors in one round trip.
   *     tags: [Metadata]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Metadata by node id.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 metadata:
   *                   type: object
   *                   additionalProperties:
   *                     type: object
   *                     properties:
   *                       transcript: { type: string, nullable: true }
   *                       delayBeforeMs: { type: integer, nullable: true }
   *                       delayAfterMs: { type: integer, nullable: true }
   *                       autoAdvance: { type: boolean, nullable: true }
   *                       autoAdvanceDelayMs: { type: integer, nullable: true }
   *                       choice1TimestampMs: { type: integer, nullable: true }
   *                       choice2TimestampMs: { type: integer, nullable: true }
   *                       characterId: { type: string, format: uuid, nullable: true }
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `
        SELECT * FROM node_metadata
        WHERE project_id = $1
        ORDER BY node_id
      `,
        [id],
      );

      // Convert to a map by node_id for easier frontend usage
      const metadataMap: Record<
        string,
        {
          transcript?: string;
          delayBeforeMs: number;
          delayAfterMs: number;
          autoAdvance: boolean;
          autoAdvanceDelayMs: number;
          choice1TimestampMs?: number;
          choice2TimestampMs?: number;
          noInlineChoiceAudio?: boolean;
          characterId?: string;
        }
      > = {};

      for (const row of result.rows) {
        metadataMap[row.node_id] = {
          transcript: row.transcript,
          delayBeforeMs: row.delay_before_ms,
          delayAfterMs: row.delay_after_ms,
          autoAdvance: row.auto_advance,
          autoAdvanceDelayMs: row.auto_advance_delay_ms,
          choice1TimestampMs: row.choice_1_timestamp_ms,
          choice2TimestampMs: row.choice_2_timestamp_ms,
          noInlineChoiceAudio: row.no_inline_choice_audio,
          characterId: row.character_id,
        };
      }

      res.json({ metadata: metadataMap, raw: result.rows });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get metadata');
      res.status(500).json({ error: 'Failed to get metadata' });
    }
  });

  // Get metadata for a specific node
  /**
   * @openapi
   * /projects/{id}/metadata/{nodeId}:
   *   get:
   *     summary: Get metadata for a single node.
   *     tags: [Metadata]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: nodeId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Metadata row (defaults to nulls when unset).
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 metadata: { type: object }
   */
  router.get('/:nodeId', async (req: Request, res: Response) => {
    try {
      const { id, nodeId } = req.params;

      const result = await pool.query(
        `
        SELECT * FROM node_metadata
        WHERE project_id = $1 AND node_id = $2
      `,
        [id, nodeId],
      );

      if (result.rows.length === 0) {
        // Return defaults if no metadata exists
        res.json({
          metadata: {
            transcript: null,
            delayBeforeMs: 0,
            delayAfterMs: 0,
            autoAdvance: true,
            autoAdvanceDelayMs: 2000,
            choice1TimestampMs: null,
            choice2TimestampMs: null,
            noInlineChoiceAudio: false,
            characterId: null,
          },
        });
        return;
      }

      const row = result.rows[0];
      res.json({
        metadata: {
          transcript: row.transcript,
          delayBeforeMs: row.delay_before_ms,
          delayAfterMs: row.delay_after_ms,
          autoAdvance: row.auto_advance,
          autoAdvanceDelayMs: row.auto_advance_delay_ms,
          choice1TimestampMs: row.choice_1_timestamp_ms,
          choice2TimestampMs: row.choice_2_timestamp_ms,
          noInlineChoiceAudio: row.no_inline_choice_audio,
          characterId: row.character_id,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get node metadata');
      res.status(500).json({ error: 'Failed to get node metadata' });
    }
  });

  // Update metadata for a specific node (upsert)
  /**
   * @openapi
   * /projects/{id}/metadata/{nodeId}:
   *   put:
   *     summary: Upsert per-node metadata (partial patch semantics).
   *     description: |
   *       Sending `transcript: null` (or empty string) clears the
   *       transcript override; omitting the field leaves the prior
   *       value intact. Timing fields accept positive integers (ms);
   *       missing fields preserve prior values.
   *     tags: [Metadata]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: nodeId
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               transcript: { type: string, nullable: true }
   *               delayBeforeMs: { type: integer }
   *               delayAfterMs: { type: integer }
   *               autoAdvance: { type: boolean }
   *               autoAdvanceDelayMs: { type: integer }
   *               choice1TimestampMs: { type: integer }
   *               choice2TimestampMs: { type: integer }
   *               characterId: { type: string, format: uuid, nullable: true }
   *     responses:
   *       200:
   *         description: Stored metadata after the upsert.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 metadata: { type: object }
   *       400: { description: Invalid field types. }
   */
  router.put('/:nodeId', async (req: Request, res: Response) => {
    try {
      const { id, nodeId } = req.params;
      const {
        transcript,
        delayBeforeMs,
        delayAfterMs,
        autoAdvance,
        autoAdvanceDelayMs,
        choice1TimestampMs,
        choice2TimestampMs,
        noInlineChoiceAudio,
        characterId,
      } = req.body;

      // If characterId is provided (and not null), validate it exists
      if (characterId !== undefined && characterId !== null) {
        const charCheck = await pool.query(
          'SELECT id FROM characters WHERE id = $1 AND project_id = $2',
          [characterId, id],
        );
        if (charCheck.rows.length === 0) {
          res.status(400).json({ error: 'Character not found' });
          return;
        }
      }

      // For the transcript column, treat explicit `null` from the client
      // the same as an empty string — both mean "clear the override".
      // Otherwise a typed `null` would round-trip through
      // COALESCE($3, existing.transcript) and silently leave the stored
      // override in place.
      const transcriptParam =
        transcript === null ? '' : transcript !== undefined ? transcript : null;

      const result = await pool.query(
        `
        INSERT INTO node_metadata (project_id, node_id, transcript, delay_before_ms, delay_after_ms, auto_advance, auto_advance_delay_ms, choice_1_timestamp_ms, choice_2_timestamp_ms, no_inline_choice_audio, character_id)
        VALUES ($1, $2, COALESCE($3, ''), COALESCE($4, 0), COALESCE($5, 0), COALESCE($6, true), COALESCE($7, 2000), $8, $9, COALESCE($10, false), $11)
        ON CONFLICT (project_id, node_id)
        DO UPDATE SET
          transcript = COALESCE($3, node_metadata.transcript),
          delay_before_ms = COALESCE($4, node_metadata.delay_before_ms),
          delay_after_ms = COALESCE($5, node_metadata.delay_after_ms),
          auto_advance = COALESCE($6, node_metadata.auto_advance),
          auto_advance_delay_ms = COALESCE($7, node_metadata.auto_advance_delay_ms),
          choice_1_timestamp_ms = COALESCE($8, node_metadata.choice_1_timestamp_ms),
          choice_2_timestamp_ms = COALESCE($9, node_metadata.choice_2_timestamp_ms),
          no_inline_choice_audio = COALESCE($10, node_metadata.no_inline_choice_audio),
          character_id = CASE WHEN $11::uuid IS NULL AND node_metadata.character_id IS NOT NULL THEN NULL ELSE COALESCE($11, node_metadata.character_id) END
        RETURNING *
      `,
        [
          id,
          nodeId,
          transcriptParam,
          delayBeforeMs !== undefined ? delayBeforeMs : null,
          delayAfterMs !== undefined ? delayAfterMs : null,
          autoAdvance !== undefined ? autoAdvance : null,
          autoAdvanceDelayMs !== undefined ? autoAdvanceDelayMs : null,
          choice1TimestampMs !== undefined ? choice1TimestampMs : null,
          choice2TimestampMs !== undefined ? choice2TimestampMs : null,
          noInlineChoiceAudio !== undefined ? noInlineChoiceAudio : null,
          characterId !== undefined ? characterId : null,
        ],
      );

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      const row = result.rows[0];
      res.json({
        metadata: {
          transcript: row.transcript,
          delayBeforeMs: row.delay_before_ms,
          delayAfterMs: row.delay_after_ms,
          autoAdvance: row.auto_advance,
          autoAdvanceDelayMs: row.auto_advance_delay_ms,
          choice1TimestampMs: row.choice_1_timestamp_ms,
          choice2TimestampMs: row.choice_2_timestamp_ms,
          noInlineChoiceAudio: row.no_inline_choice_audio,
          characterId: row.character_id,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update node metadata');
      res.status(500).json({ error: 'Failed to update node metadata' });
    }
  });

  // Delete metadata for a specific node
  /**
   * @openapi
   * /projects/{id}/metadata/{nodeId}:
   *   delete:
   *     summary: Drop a node's metadata row entirely.
   *     description: |
   *       Used when removing all per-node customisations at once
   *       (e.g. after a story-graph node is renamed or removed).
   *     tags: [Metadata]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: nodeId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Removed (or already absent).
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   */
  router.delete('/:nodeId', async (req: Request, res: Response) => {
    try {
      const { id, nodeId } = req.params;

      const result = await pool.query(
        `
        DELETE FROM node_metadata
        WHERE project_id = $1 AND node_id = $2
        RETURNING *
      `,
        [id, nodeId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Metadata not found' });
        return;
      }

      // Update project timestamp
      await pool.query('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      res.json({ success: true, deleted: result.rows[0] });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to delete node metadata');
      res.status(500).json({ error: 'Failed to delete node metadata' });
    }
  });

  return router;
}
