import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

export function createCharactersRouter(pool: Pool): Router {
  const router = Router({ mergeParams: true });

  /**
   * @openapi
   * /projects/{id}/characters:
   *   get:
   *     summary: List characters for a project.
   *     tags: [Characters]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Characters.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 characters:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string, format: uuid }
   *                       name: { type: string }
   *                       color: { type: string }
   *                       theme: { type: string, enum: [red, orange, yellow, green, blue, indigo, purple, pink] }
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `
        SELECT c.*,
               COUNT(af.id) as audio_count
        FROM characters c
        LEFT JOIN audio_files af ON af.character_id = c.id
        WHERE c.project_id = $1
        GROUP BY c.id
        ORDER BY c.name
      `,
        [id],
      );

      res.json({ characters: result.rows });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get characters');
      res.status(500).json({ error: 'Failed to get characters' });
    }
  });

  // Create a new character
  /**
   * @openapi
   * /projects/{id}/characters:
   *   post:
   *     summary: Create a character.
   *     tags: [Characters]
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
   *             required: [name]
   *             properties:
   *               name: { type: string }
   *               color: { type: string, default: '#9c27b0' }
   *               theme: { type: string, enum: [red, orange, yellow, green, blue, indigo, purple, pink] }
   *     responses:
   *       201: { description: Created. }
   *       400: { description: Missing name or duplicate within project. }
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { name, color, theme } = req.body;

      if (!name || !name.trim()) {
        res.status(400).json({ error: 'Character name is required' });
        return;
      }

      const result = await pool.query(
        `
        INSERT INTO characters (project_id, name, color, theme)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
        [id, name.trim(), color || '#9c27b0', theme || 'purple'],
      );

      res.status(201).json({ character: result.rows[0] });
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        res.status(400).json({ error: 'A character with this name already exists' });
        return;
      }
      req.log.error({ err: error }, 'Failed to create character');
      res.status(500).json({ error: 'Failed to create character' });
    }
  });

  // Update a character
  /**
   * @openapi
   * /projects/{id}/characters/{characterId}:
   *   patch:
   *     summary: Update a character.
   *     tags: [Characters]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: characterId
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
   *               color: { type: string }
   *               theme: { type: string }
   *     responses:
   *       200: { description: Updated. }
   *       404: { description: Character not found. }
   */
  router.patch('/:characterId', async (req: Request, res: Response) => {
    try {
      const { id, characterId } = req.params;
      const { name, color, theme } = req.body;

      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(name.trim());
      }
      if (color !== undefined) {
        updates.push(`color = $${paramIndex++}`);
        values.push(color);
      }
      if (theme !== undefined) {
        updates.push(`theme = $${paramIndex++}`);
        values.push(theme);
      }

      if (updates.length === 0) {
        res.status(400).json({ error: 'No updates provided' });
        return;
      }

      values.push(characterId, id);
      const result = await pool.query(
        `
        UPDATE characters
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramIndex++} AND project_id = $${paramIndex}
        RETURNING *
      `,
        values,
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Character not found' });
        return;
      }

      res.json({ character: result.rows[0] });
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        res.status(400).json({ error: 'A character with this name already exists' });
        return;
      }
      req.log.error({ err: error }, 'Failed to update character');
      res.status(500).json({ error: 'Failed to update character' });
    }
  });

  // Delete a character
  /**
   * @openapi
   * /projects/{id}/characters/{characterId}:
   *   delete:
   *     summary: Delete a character.
   *     description: |
   *       Frees the character_id on any node_metadata rows that
   *       referenced it (sets them NULL) so the FK doesn't block deletion.
   *     tags: [Characters]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: characterId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200: { description: Deleted. }
   *       404: { description: Character not found. }
   */
  router.delete('/:characterId', async (req: Request, res: Response) => {
    try {
      const { id, characterId } = req.params;

      const result = await pool.query(
        `
        DELETE FROM characters
        WHERE id = $1 AND project_id = $2
        RETURNING *
      `,
        [characterId, id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Character not found' });
        return;
      }

      res.json({ success: true, deleted: result.rows[0] });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to delete character');
      res.status(500).json({ error: 'Failed to delete character' });
    }
  });

  return router;
}
