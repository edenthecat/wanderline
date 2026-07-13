import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import type { RequireOwnerOrAdmin } from '../middleware/auth.js';

const COLLABORATORS_ERROR = 'Only project owners can manage collaborators';

export function createCollaboratorsRouter(
  pool: Pool,
  sharedRequireOwnerOrAdmin: RequireOwnerOrAdmin,
): Router {
  const router = Router({ mergeParams: true });

  // Wrap the shared helper with this router's context-specific 403
  // message so existing clients continue to see the same copy.
  const requireOwnerOrAdmin = (req: Request, res: Response, projectId: string) =>
    sharedRequireOwnerOrAdmin(req, res, projectId, COLLABORATORS_ERROR);

  /**
   * @openapi
   * /projects/{id}/collaborators:
   *   get:
   *     summary: List collaborators on a project.
   *     tags: [Collaborators]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Collaborators.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 collaborators:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string, format: uuid }
   *                       userId: { type: string, format: uuid }
   *                       email: { type: string, format: email }
   *                       role: { type: string, enum: [owner, editor] }
   *                       createdAt: { type: string, format: date-time }
   */
  router.get('/', async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        `SELECT pc.id, pc.user_id, pc.role, pc.created_at,
                u.email, u.display_name
         FROM project_collaborators pc
         JOIN users u ON u.id = pc.user_id
         WHERE pc.project_id = $1
         ORDER BY pc.created_at ASC`,
        [id],
      );
      res.json({ collaborators: result.rows });
    } catch (err) {
      req.log.error({ err }, 'Error listing collaborators');
      res.status(500).json({ error: 'Failed to list collaborators' });
    }
  });

  // POST / — add a collaborator (owner-only)
  /**
   * @openapi
   * /projects/{id}/collaborators:
   *   post:
   *     summary: Add a collaborator (by email or user id).
   *     description: |
   *       Owner-only. Defaults `role` to `editor`. Refuses duplicates.
   *     tags: [Collaborators]
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
   *               email: { type: string, format: email }
   *               userId: { type: string, format: uuid }
   *               role: { type: string, enum: [owner, editor], default: editor }
   *     responses:
   *       201: { description: Added. }
   *       400: { description: Missing identifier or invalid role. }
   *       404: { description: User not found. }
   *       409: { description: Already a collaborator. }
   */
  router.post('/', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { email, userId, role } = req.body;

    if (!(await requireOwnerOrAdmin(req, res, id))) return;

    if (email && userId) {
      return res.status(400).json({ error: 'Provide either email or userId, not both' });
    }

    const validRoles = ['owner', 'editor'];
    if (role !== undefined && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be owner or editor' });
    }
    const assignRole = role || 'editor';

    try {
      // Resolve target user — always verify active status
      let targetUserId: string | undefined;
      if (email) {
        if (typeof email !== 'string' || !email.trim()) {
          return res.status(400).json({ error: 'Email must be a non-empty string' });
        }
        const normalizedEmail = email.toLowerCase().trim();
        const userResult = await pool.query(
          `SELECT id FROM users WHERE email = $1 AND is_active = true`,
          [normalizedEmail],
        );
        if (userResult.rows.length === 0) {
          return res.status(404).json({ error: 'User not found' });
        }
        targetUserId = userResult.rows[0].id;
      } else if (userId) {
        if (typeof userId !== 'string') {
          return res.status(400).json({ error: 'userId must be a string' });
        }
        const userCheck = await pool.query(
          `SELECT id FROM users WHERE id = $1 AND is_active = true`,
          [userId],
        );
        if (userCheck.rows.length === 0) {
          return res.status(404).json({ error: 'User not found or inactive' });
        }
        targetUserId = userCheck.rows[0].id;
      }

      if (!targetUserId) {
        return res.status(400).json({ error: 'Either email or userId is required' });
      }

      const result = await pool.query(
        `INSERT INTO project_collaborators (project_id, user_id, role)
         VALUES ($1, $2, $3)
         RETURNING id, project_id, user_id, role, created_at`,
        [id, targetUserId, assignRole],
      );

      res.status(201).json({ collaborator: result.rows[0] });
    } catch (err) {
      // pg error rows carry a 5-character SQLSTATE string in
      // `.code` (e.g. '23505' for unique_violation, '23503' for
      // foreign_key_violation). Narrow off unknown via a shape
      // check instead of `any` so a future refactor can't shadow
      // a rethrown non-pg error.
      const code =
        err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
          ? err.code
          : null;
      if (code === '23505') {
        return res.status(409).json({ error: 'User is already a collaborator on this project' });
      }
      if (code === '23503') {
        return res.status(400).json({ error: 'Invalid project or user reference' });
      }
      req.log.error({ err }, 'Error adding collaborator');
      res.status(500).json({ error: 'Failed to add collaborator' });
    }
  });

  // PATCH /:userId — update collaborator role (owner-only)
  /**
   * @openapi
   * /projects/{id}/collaborators/{userId}:
   *   patch:
   *     summary: Change a collaborator's role.
   *     description: |
   *       Owner-only. Refuses demoting the last owner.
   *     tags: [Collaborators]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: userId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [role]
   *             properties:
   *               role: { type: string, enum: [owner, editor] }
   *     responses:
   *       200: { description: Updated. }
   *       400: { description: Invalid role or last-owner protection. }
   *       404: { description: Collaborator not found. }
   */
  router.patch('/:userId', async (req: Request, res: Response) => {
    const { id, userId } = req.params;
    const { role } = req.body;

    if (!(await requireOwnerOrAdmin(req, res, id))) return;

    const validRoles = ['owner', 'editor'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Valid role is required (owner or editor)' });
    }

    try {
      // Prevent demoting the last owner — use transaction to avoid race condition
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (role !== 'owner') {
          const ownerCount = await client.query(
            `SELECT COUNT(*) FROM project_collaborators WHERE project_id = $1 AND role = 'owner' FOR UPDATE`,
            [id],
          );
          const targetCurrent = await client.query(
            `SELECT role FROM project_collaborators WHERE project_id = $1 AND user_id = $2 FOR UPDATE`,
            [id, userId],
          );
          if (
            targetCurrent.rows[0]?.role === 'owner' &&
            parseInt(ownerCount.rows[0].count, 10) <= 1
          ) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Cannot demote the last owner' });
          }
        }

        const result = await client.query(
          `UPDATE project_collaborators SET role = $1
           WHERE project_id = $2 AND user_id = $3
           RETURNING id, project_id, user_id, role, created_at`,
          [role, id, userId],
        );
        await client.query('COMMIT');

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Collaborator not found' });
        }

        res.json({ collaborator: result.rows[0] });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      req.log.error({ err }, 'Error updating collaborator');
      res.status(500).json({ error: 'Failed to update collaborator' });
    }
  });

  // DELETE /:userId — remove a collaborator (owner-only)
  /**
   * @openapi
   * /projects/{id}/collaborators/{userId}:
   *   delete:
   *     summary: Remove a collaborator.
   *     description: |
   *       Owner-only. Refuses removing the last owner.
   *     tags: [Collaborators]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *       - in: path
   *         name: userId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200: { description: Removed. }
   *       400: { description: Cannot remove the last owner. }
   *       404: { description: Collaborator not found. }
   */
  router.delete('/:userId', async (req: Request, res: Response) => {
    const { id, userId } = req.params;

    if (!(await requireOwnerOrAdmin(req, res, id))) return;

    try {
      // Prevent removing the last owner — use transaction to avoid race condition
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const targetRole = await client.query(
          `SELECT role FROM project_collaborators WHERE project_id = $1 AND user_id = $2 FOR UPDATE`,
          [id, userId],
        );
        if (targetRole.rows[0]?.role === 'owner') {
          const ownerCount = await client.query(
            `SELECT COUNT(*) FROM project_collaborators WHERE project_id = $1 AND role = 'owner' FOR UPDATE`,
            [id],
          );
          if (parseInt(ownerCount.rows[0].count, 10) <= 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Cannot remove the last owner' });
          }
        }

        const result = await client.query(
          `DELETE FROM project_collaborators WHERE project_id = $1 AND user_id = $2 RETURNING id`,
          [id, userId],
        );
        await client.query('COMMIT');

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Collaborator not found' });
        }

        res.status(204).send();
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      req.log.error({ err }, 'Error removing collaborator');
      res.status(500).json({ error: 'Failed to remove collaborator' });
    }
  });

  return router;
}
