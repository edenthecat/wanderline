import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS, validateCredentials } from '../services/credentials.js';

export function createSetupRouter(pool: Pool): Router {
  const router = Router();

  /**
   * @openapi
   * /setup/status:
   *   get:
   *     summary: Whether first-time setup is still required.
   *     description: |
   *       Public. Returns `{ needsSetup: true }` when no users exist
   *       yet, so the editor can route fresh installs to the setup
   *       screen instead of /login.
   *     tags: [Setup]
   *     security: []
   *     responses:
   *       200:
   *         description: Setup status.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 needsSetup: { type: boolean }
   */
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const result = await pool.query('SELECT COUNT(*) as count FROM users');
      const needsSetup = parseInt(result.rows[0].count, 10) === 0;
      res.json({ needsSetup });
    } catch (error: unknown) {
      // Table doesn't exist yet (42P01 = undefined_table) — setup is needed
      if (error && typeof error === 'object' && 'code' in error && error.code === '42P01') {
        res.json({ needsSetup: true });
        return;
      }
      req.log.error({ err: error }, 'Setup status check failed');
      res.status(500).json({ error: 'Failed to check setup status' });
    }
  });

  /**
   * @openapi
   * /setup:
   *   post:
   *     summary: Create the initial admin account.
   *     description: |
   *       Public ONLY while `needsSetup === true`. Once a user exists,
   *       subsequent calls 400 — additional users go through POST
   *       /users (admin) or POST /invitations (magic link).
   *     tags: [Setup]
   *     security: []
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
   *     responses:
   *       201:
   *         description: Admin created + session cookie issued.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 user: { $ref: '#/components/schemas/AuthUser' }
   *       400: { description: Setup already complete or invalid fields. }
   */
  router.post('/', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const creds = validateCredentials(req.body);
      if (!creds.ok) {
        res.status(400).json({ error: creds.error });
        return;
      }
      const { email, password, displayName: trimmedName } = creds;

      // Use serializable transaction to prevent race condition
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      const countResult = await client.query('SELECT COUNT(*) as count FROM users');
      if (parseInt(countResult.rows[0].count, 10) > 0) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'Setup has already been completed' });
        return;
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const result = await client.query(
        `INSERT INTO users (email, password_hash, display_name, role)
         VALUES ($1, $2, $3, 'admin')
         RETURNING id, email, display_name, role`,
        [email, passwordHash, trimmedName],
      );

      const user = result.rows[0];

      // Assign any existing ownerless projects to this admin
      await client.query('UPDATE projects SET owner_id = $1 WHERE owner_id IS NULL', [user.id]);
      const orphanedProjects = await client.query('SELECT id FROM projects WHERE owner_id = $1', [
        user.id,
      ]);
      for (const project of orphanedProjects.rows) {
        await client.query(
          `INSERT INTO project_collaborators (project_id, user_id, role)
           VALUES ($1, $2, 'owner')
           ON CONFLICT (project_id, user_id) DO NOTHING`,
          [project.id, user.id],
        );
      }

      await client.query('COMMIT');

      const userResponse = {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
      };

      // Regenerate session to prevent fixation
      req.session.regenerate((err) => {
        if (err) {
          req.log.error({ err }, 'Session regeneration failed');
          // Account was created — tell the client to log in manually
          res.status(201).json({ user: userResponse, sessionFailed: true });
          return;
        }

        req.session.userId = user.id;

        req.session.save((err) => {
          if (err) {
            req.log.error({ err }, 'Session save failed');
            res.status(201).json({ user: userResponse, sessionFailed: true });
            return;
          }

          res.status(201).json({ user: userResponse });
        });
      });
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === '23505') {
          res.status(400).json({ error: 'A user with this email already exists' });
          return;
        }
        if (error.code === '40001') {
          res.status(409).json({ error: 'Setup was completed by another request, please refresh' });
          return;
        }
      }
      req.log.error({ err: error }, 'Setup failed');
      res.status(500).json({ error: 'Setup failed' });
    } finally {
      client.release();
    }
  });

  return router;
}
