import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import { logger } from '../logger.js';
import {
  BCRYPT_ROUNDS,
  MAX_DISPLAY_NAME_LENGTH,
  validateCredentials,
  validatePassword,
} from '../services/credentials.js';

export function createUsersRouter(pool: Pool): Router {
  const router = Router();

  /**
   * @openapi
   * /users:
   *   get:
   *     summary: List all users.
   *     description: Admin-only.
   *     tags: [Users]
   *     responses:
   *       200:
   *         description: Users list.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 users:
   *                   type: array
   *                   items: { $ref: '#/components/schemas/User' }
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const result = await pool.query(`
        SELECT id, email, display_name, role, is_active, created_at, updated_at
        FROM users
        ORDER BY created_at ASC
      `);

      res.json({
        users: result.rows.map((row) => ({
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          role: row.role,
          isActive: row.is_active,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to list users');
      res.status(500).json({ error: 'Failed to list users' });
    }
  });

  /**
   * @openapi
   * /users:
   *   post:
   *     summary: Create a user with an explicit password.
   *     description: |
   *       Admin-only. Bypasses the invitation flow — use this only when
   *       you need to set a password directly (CI bootstrap, test rigs).
   *       For normal onboarding prefer POST /invitations.
   *     tags: [Users]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password, displayName]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string, minLength: 8, maxLength: 128 }
   *               displayName: { type: string, maxLength: 255 }
   *               role: { type: string, enum: [admin, editor], default: editor }
   *     responses:
   *       201:
   *         description: Created.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 user: { $ref: '#/components/schemas/User' }
   *       400: { description: Missing / invalid fields or email already taken. }
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const creds = validateCredentials(req.body);
      if (!creds.ok) {
        res.status(400).json({ error: creds.error });
        return;
      }
      const { email, password, displayName: trimmedName } = creds;
      const { role } = req.body;

      const userRole = role === 'admin' ? 'admin' : 'editor';
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const result = await pool.query(
        `INSERT INTO users (email, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, role, is_active, created_at`,
        [email, passwordHash, trimmedName, userRole],
      );

      const user = result.rows[0];
      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
          isActive: user.is_active,
          createdAt: user.created_at,
        },
      });
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        res.status(400).json({ error: 'A user with this email already exists' });
        return;
      }
      req.log.error({ err: error }, 'Failed to create user');
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  /**
   * @openapi
   * /users/{userId}:
   *   patch:
   *     summary: Update a user.
   *     description: |
   *       Admin-only. Any subset of fields may be supplied. Role +
   *       active-status changes guard against the "last admin demoted"
   *       and "self-deactivation" footguns.
   *     tags: [Users]
   *     parameters:
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
   *             properties:
   *               displayName: { type: string, maxLength: 255 }
   *               password: { type: string, minLength: 8, maxLength: 128 }
   *               role: { type: string, enum: [admin, editor] }
   *               isActive: { type: boolean }
   *     responses:
   *       200:
   *         description: Updated.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 user: { $ref: '#/components/schemas/User' }
   *       400: { description: Invalid input or invariant violation. }
   *       404: { description: User not found. }
   */
  router.patch('/:userId', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const { displayName, password, role, isActive } = req.body;
      const currentUser = req.user!;
      const isAdmin = currentUser.role === 'admin';

      // This route is behind requireAdmin, so only admins reach here
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (displayName !== undefined) {
        if (typeof displayName !== 'string') {
          res.status(400).json({ error: 'Display name must be a string' });
          return;
        }
        const trimmedName = displayName.trim();
        if (!trimmedName) {
          res.status(400).json({ error: 'Display name cannot be empty' });
          return;
        }
        if (trimmedName.length > MAX_DISPLAY_NAME_LENGTH) {
          res
            .status(400)
            .json({ error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer` });
          return;
        }
        updates.push(`display_name = $${paramIndex++}`);
        values.push(trimmedName);
      }

      if (password !== undefined) {
        const passwordResult = validatePassword(password);
        if (!passwordResult.ok) {
          res.status(400).json({ error: passwordResult.error });
          return;
        }
        updates.push(`password_hash = $${paramIndex++}`);
        values.push(await bcrypt.hash(passwordResult.password, BCRYPT_ROUNDS));
      }

      // Role changes
      let lastAdminGuardNeeded = false;
      if (role !== undefined && isAdmin) {
        if (typeof role !== 'string' || !['admin', 'editor'].includes(role)) {
          res.status(400).json({ error: 'Role must be "admin" or "editor"' });
          return;
        }
        // The count-then-update pair for the last-admin check has to
        // happen inside a single transaction with a row lock on the
        // active-admin rows. Otherwise two admins concurrently demoting
        // themselves both observe count=2, both pass the guard, and
        // both UPDATEs commit — leaving zero active admins and locking
        // every admin-only route until direct DB access repairs it.
        // Actual lock happens in the transactional path below.
        if (currentUser.id === userId) {
          lastAdminGuardNeeded = true;
        }
        updates.push(`role = $${paramIndex++}`);
        values.push(role);
      }

      // Deactivation/activation — validate as strict boolean
      if (isActive !== undefined && isAdmin) {
        if (typeof isActive !== 'boolean') {
          res.status(400).json({ error: 'isActive must be a boolean' });
          return;
        }
        if (currentUser.id === userId && !isActive) {
          res.status(400).json({ error: 'Cannot deactivate your own account' });
          return;
        }
        updates.push(`is_active = $${paramIndex++}`);
        values.push(isActive);
      }

      if (updates.length === 0) {
        res.status(400).json({ error: 'No valid updates provided' });
        return;
      }

      values.push(userId);
      const updateSql = `UPDATE users SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING id, email, display_name, role, is_active, created_at, updated_at`;

      let result;
      if (lastAdminGuardNeeded && role !== 'admin') {
        // Self-demote path: lock every active-admin row inside a
        // transaction so concurrent demotes serialize. Postgres does
        // not allow FOR UPDATE with an aggregate function, so select
        // the id column and count the rows in JS. When a second
        // demote lands mid-flight it blocks on the first tx's row
        // locks and observes the post-decrement count on unlock.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const adminRows = await client.query(
            "SELECT id FROM users WHERE role = 'admin' AND is_active = true FOR UPDATE",
          );
          if (adminRows.rowCount !== null && adminRows.rowCount <= 1) {
            await client.query('ROLLBACK');
            res.status(400).json({ error: 'Cannot demote the last admin' });
            return;
          }
          result = await client.query(updateSql, values);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      } else {
        result = await pool.query(updateSql, values);
      }

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // If user was deactivated, destroy their sessions
      const updatedUser = result.rows[0];
      if (!updatedUser.is_active) {
        await invalidateUserSessions(pool, userId);
      }

      res.json({
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          displayName: updatedUser.display_name,
          role: updatedUser.role,
          isActive: updatedUser.is_active,
          createdAt: updatedUser.created_at,
          updatedAt: updatedUser.updated_at,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update user');
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  /**
   * @openapi
   * /users/{userId}:
   *   delete:
   *     summary: Deactivate a user (soft delete).
   *     description: |
   *       Admin-only. Sets `is_active = false` and destroys any active
   *       session for the user. Self-deactivation is refused.
   *     tags: [Users]
   *     parameters:
   *       - in: path
   *         name: userId
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Deactivated.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *                 user: { $ref: '#/components/schemas/User' }
   *       400: { description: Cannot deactivate own account. }
   *       404: { description: User not found. }
   */
  router.delete('/:userId', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const currentUser = req.user!;

      if (currentUser.id === userId) {
        res.status(400).json({ error: 'Cannot deactivate your own account' });
        return;
      }

      const result = await pool.query(
        `UPDATE users SET is_active = false
         WHERE id = $1
         RETURNING id, email, display_name, role`,
        [userId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Destroy deactivated user's sessions
      await invalidateUserSessions(pool, userId);

      const row = result.rows[0];
      res.json({
        success: true,
        user: {
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          role: row.role,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to deactivate user');
      res.status(500).json({ error: 'Failed to deactivate user' });
    }
  });

  return router;
}

async function invalidateUserSessions(pool: Pool, userId: string): Promise<void> {
  try {
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [userId]);
  } catch (error) {
    logger.error({ err: error }, 'Failed to invalidate user sessions');
  }
}
