import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';

const MAX_PASSWORD_LENGTH = 128;
// Dummy hash to compare against when user doesn't exist, preventing timing-based enumeration
const DUMMY_HASH = '$2b$12$000000000000000000000uGE6GV5wqFSnmOAzGGOJSqxPMaZVdYi';

export function createAuthRouter(pool: Pool): Router {
  const router = Router();

  /**
   * @openapi
   * /auth/login:
   *   post:
   *     summary: Log in with email + password
   *     tags: [Auth]
   *     security: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, password]
   *             properties:
   *               email: { type: string, format: email }
   *               password: { type: string }
   *     responses:
   *       200:
   *         description: Logged in; session cookie issued.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 user: { $ref: '#/components/schemas/AuthUser' }
   *       401:
   *         description: Invalid credentials or deactivated account.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Error' }
   */
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
        res.status(400).json({ error: 'Email and password are required' });
        return;
      }

      // Reject oversized passwords before bcrypt to prevent CPU DoS
      if (password.length > MAX_PASSWORD_LENGTH) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      const result = await pool.query(
        'SELECT id, email, password_hash, display_name, role, is_active FROM users WHERE email = $1',
        [email.toLowerCase().trim()],
      );

      const user = result.rows.length > 0 ? result.rows[0] : null;

      // Always run bcrypt.compare to prevent timing-based user enumeration
      const passwordValid = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
      if (!user || !passwordValid || !user.is_active) {
        // Same error for wrong password and deactivated accounts to avoid leaking account state
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      // Regenerate session to prevent fixation
      req.session.regenerate((err) => {
        if (err) {
          req.log.error({ err }, 'Session regeneration failed');
          res.status(500).json({ error: 'Login failed' });
          return;
        }

        req.session.userId = user.id;

        req.session.save((err) => {
          if (err) {
            req.log.error({ err }, 'Session save failed');
            res.status(500).json({ error: 'Login failed' });
            return;
          }

          res.json({
            user: {
              id: user.id,
              email: user.email,
              displayName: user.display_name,
              role: user.role,
            },
          });
        });
      });
    } catch (error) {
      req.log.error({ err: error }, 'Login failed');
      res.status(500).json({ error: 'Login failed' });
    }
  });

  /**
   * @openapi
   * /auth/logout:
   *   post:
   *     summary: End the current session.
   *     tags: [Auth]
   *     responses:
   *       200:
   *         description: Session destroyed.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties: { success: { type: boolean } }
   */
  router.post('/logout', (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        req.log.error({ err }, 'Logout failed');
        res.status(500).json({ error: 'Logout failed' });
        return;
      }
      res.clearCookie('connect.sid', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
      res.json({ success: true });
    });
  });

  /**
   * @openapi
   * /auth/me:
   *   get:
   *     summary: Return the user attached to the current session.
   *     tags: [Auth]
   *     responses:
   *       200:
   *         description: Current user.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 user: { $ref: '#/components/schemas/AuthUser' }
   *       401:
   *         description: Not authenticated.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Error' }
   */
  router.get('/me', async (req: Request, res: Response) => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      const result = await pool.query(
        'SELECT id, email, display_name, role FROM users WHERE id = $1 AND is_active = true',
        [req.session.userId],
      );

      if (result.rows.length === 0) {
        req.session.destroy(() => {});
        res.clearCookie('connect.sid', {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
        });
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const user = result.rows[0];
      res.json({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get current user');
      res.status(500).json({ error: 'Failed to get current user' });
    }
  });

  return router;
}
