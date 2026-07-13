import { Router, Request, Response, RequestHandler } from 'express';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import {
  BCRYPT_ROUNDS,
  MAX_DISPLAY_NAME_LENGTH,
  validatePassword,
} from '../services/credentials.js';
// Tokens live for 7 days. Long enough that an admin can hand the link
// over async without it expiring in the recipient's queue, short enough
// that a leaked link doesn't stay valid forever.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Expired-invitation sweep: drop rows whose expires_at is older than
// 30 days. We retain a window of revoked / consumed rows so the audit
// log + accepted_user_id lineage stays queryable for that period.
// Returns the number of rows deleted (mostly so tests can assert).
export async function cleanupExpiredInvitations(pool: Pool): Promise<number> {
  const result = await pool.query(
    `DELETE FROM user_invitations
     WHERE expires_at < NOW() - INTERVAL '30 days'`,
  );
  return result.rowCount ?? 0;
}

function publicInvitation(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

// Build the magic link URL the admin will copy. PUBLIC_BASE_URL takes
// precedence so prod points at the deployed editor; otherwise we fall
// back to the request's host so dev/staging Just Work.
function buildMagicLinkUrl(req: Request, token: string): string {
  const base =
    process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ??
    `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  return `${base}/invite/${encodeURIComponent(token)}`;
}

export function createInvitationsRouter(pool: Pool, createLimiter?: RequestHandler): Router {
  const router = Router();

  /**
   * @openapi
   * /invitations:
   *   post:
   *     summary: Generate a one-time magic-link invitation.
   *     description: |
   *       Admin-only. The raw token is returned ONCE inside `magicLinkUrl`
   *       and never persisted in plaintext; only its SHA-256 hash lives in
   *       the database. Rate-limited (20 / IP / hour by default).
   *     tags: [Invitations]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [email, role]
   *             properties:
   *               email: { type: string, format: email }
   *               role: { type: string, enum: [admin, editor] }
   *     responses:
   *       201:
   *         description: Invitation created.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 invitation: { $ref: '#/components/schemas/PendingInvitation' }
   *                 magicLinkUrl: { type: string, format: uri }
   *       400:
   *         description: Missing / invalid fields, or email already a registered user.
   *       409: { description: A pending invitation for this email already exists. }
   */
  // The optional createLimiter rate-limits *creation only*; GET and
  // DELETE flow through the broader apiLimiter so an admin can refresh
  // the page freely.
  router.post(
    '/',
    createLimiter ?? ((_req, _res, next) => next()),
    async (req: Request, res: Response) => {
      try {
        const { email, role } = req.body;

        if (typeof email !== 'string' || !email.trim()) {
          res.status(400).json({ error: 'Email is required' });
          return;
        }
        if (typeof role !== 'string' || !['admin', 'editor'].includes(role)) {
          res.status(400).json({ error: 'Role must be "admin" or "editor"' });
          return;
        }

        const normalizedEmail = email.toLowerCase().trim();

        // Refuse if any users row already exists for this email
        // (active or deactivated). The accept path checks the same way,
        // so blocking only is_active=true here would let admins create
        // invitations that 409 forever at accept time.
        const existingUser = await pool.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [
          normalizedEmail,
        ]);
        if (existingUser.rows.length > 0) {
          res.status(400).json({ error: 'A user with this email already exists' });
          return;
        }

        // Refuse if there's a still-pending invitation for the same
        // email — admin has to revoke it first. Prevents accidental
        // duplicates with diverging roles.
        const pending = await pool.query(
          `SELECT 1 FROM user_invitations
         WHERE email = $1
           AND accepted_at IS NULL
           AND revoked_at IS NULL
           AND expires_at > NOW()
         LIMIT 1`,
          [normalizedEmail],
        );
        if (pending.rows.length > 0) {
          res.status(409).json({
            error: 'A pending invitation already exists for this email. Revoke it first.',
          });
          return;
        }

        const token = randomBytes(TOKEN_BYTES).toString('base64url');
        const tokenHash = hashToken(token);
        const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

        const inserted = await pool.query(
          `INSERT INTO user_invitations (email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, role, invited_by, expires_at, created_at`,
          [normalizedEmail, role, tokenHash, req.user?.id ?? null, expiresAt],
        );

        const row = inserted.rows[0];
        req.log.info(
          { event: 'invitation.create', invitationId: row.id, email: row.email, role: row.role },
          'Invitation created',
        );

        res.status(201).json({
          invitation: publicInvitation(row),
          // Raw token + URL — shown to the admin ONCE. The DB only ever
          // stores the hash, so this response is the only chance to copy.
          magicLinkUrl: buildMagicLinkUrl(req, token),
        });
      } catch (error) {
        req.log.error({ err: error }, 'Failed to create invitation');
        res.status(500).json({ error: 'Failed to create invitation' });
      }
    },
  );

  /**
   * @openapi
   * /invitations:
   *   get:
   *     summary: List pending invitations.
   *     description: Admin-only. Returns invitations that are not accepted, not revoked, and not expired.
   *     tags: [Invitations]
   *     responses:
   *       200:
   *         description: Pending list.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 invitations:
   *                   type: array
   *                   items: { $ref: '#/components/schemas/PendingInvitation' }
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT id, email, role, invited_by, expires_at, created_at
         FROM user_invitations
         WHERE accepted_at IS NULL
           AND revoked_at IS NULL
           AND expires_at > NOW()
         ORDER BY created_at DESC`,
      );
      res.json({ invitations: result.rows.map(publicInvitation) });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to list invitations');
      res.status(500).json({ error: 'Failed to list invitations' });
    }
  });

  /**
   * @openapi
   * /invitations/{id}:
   *   delete:
   *     summary: Revoke a pending invitation.
   *     description: |
   *       Admin-only. Already-accepted invitations 404 — once a user
   *       record exists, deactivate it via `/users/{userId}` instead.
   *     tags: [Invitations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Revoked.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties: { success: { type: boolean } }
   *       404: { description: Invitation not found or already accepted. }
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `UPDATE user_invitations
         SET revoked_at = NOW()
         WHERE id = $1
           AND accepted_at IS NULL
           AND revoked_at IS NULL
         RETURNING id, email`,
        [id],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Invitation not found' });
        return;
      }
      req.log.info(
        { event: 'invitation.revoke', invitationId: result.rows[0].id },
        'Invitation revoked',
      );
      res.json({ success: true });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to revoke invitation');
      res.status(500).json({ error: 'Failed to revoke invitation' });
    }
  });

  return router;
}

// Public (unauthenticated) lookup + accept endpoints. Mounted under a
// separate path so the auth middleware stack doesn't fence them off.
// `lookupLimiter` and `acceptLimiter` are the fine-grained
// rate limiters; the parent mount uses authLim as a baseline.
export function createPublicInvitationsRouter(
  pool: Pool,
  lookupLimiter?: RequestHandler,
  acceptLimiter?: RequestHandler,
): Router {
  const router = Router();

  /**
   * @openapi
   * /invitations/token/{token}:
   *   get:
   *     summary: Resolve a magic-link token.
   *     description: |
   *       Public endpoint. Returns minimal metadata the acceptance form
   *       needs. Does NOT leak whether the email is already a registered
   *       user. 410 is uniform for expired / revoked / already-accepted.
   *     tags: [Invitations]
   *     security: []
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Valid invitation.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 invitation:
   *                   type: object
   *                   properties:
   *                     email: { type: string, format: email }
   *                     role: { type: string, enum: [admin, editor] }
   *                     expiresAt: { type: string, format: date-time }
   *       404: { description: Token not found. }
   *       410:
   *         description: Expired, revoked, or already accepted.
   */
  router.get(
    '/:token',
    ...(lookupLimiter ? [lookupLimiter] : []),
    async (req: Request, res: Response) => {
      try {
        const { token } = req.params;
        if (typeof token !== 'string' || !token) {
          res.status(400).json({ error: 'Token is required' });
          return;
        }

        const result = await pool.query(
          `SELECT id, email, role, expires_at, accepted_at, revoked_at
         FROM user_invitations
         WHERE token_hash = $1
         LIMIT 1`,
          [hashToken(token)],
        );
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Invitation not found' });
          return;
        }
        const inv = result.rows[0];
        if (inv.accepted_at || inv.revoked_at || new Date(inv.expires_at).getTime() <= Date.now()) {
          // Same 410 for all "no longer usable" cases so we don't leak
          // why it's invalid.
          res.status(410).json({ error: 'This invitation is no longer valid' });
          return;
        }
        res.json({
          invitation: {
            email: inv.email,
            role: inv.role,
            expiresAt: inv.expires_at,
          },
        });
      } catch (error) {
        req.log.error({ err: error }, 'Failed to look up invitation');
        res.status(500).json({ error: 'Failed to look up invitation' });
      }
    },
  );

  /**
   * @openapi
   * /invitations/token/{token}/accept:
   *   post:
   *     summary: Consume a magic-link token and create the account.
   *     description: |
   *       Public endpoint. Atomic: re-validates the token under a row
   *       lock, creates a `users` row with the invitation's email + role,
   *       marks the invitation accepted, and issues a session cookie.
   *     tags: [Invitations]
   *     security: []
   *     parameters:
   *       - in: path
   *         name: token
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [displayName, password]
   *             properties:
   *               displayName: { type: string, maxLength: 255 }
   *               password: { type: string, minLength: 8, maxLength: 128 }
   *     responses:
   *       201:
   *         description: Account created, session cookie issued.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 user: { $ref: '#/components/schemas/AuthUser' }
   *       400: { description: Missing / invalid fields. }
   *       404: { description: Token not found. }
   *       409: { description: An account with this email already exists. }
   *       410:
   *         description: Expired, revoked, or already accepted.
   */
  router.post(
    '/:token/accept',
    ...(acceptLimiter ? [acceptLimiter] : []),
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const { token } = req.params;
        const { displayName, password } = req.body;

        if (typeof token !== 'string' || !token) {
          res.status(400).json({ error: 'Token is required' });
          return;
        }
        if (typeof displayName !== 'string' || !displayName.trim()) {
          res.status(400).json({ error: 'Display name is required' });
          return;
        }
        if (displayName.trim().length > MAX_DISPLAY_NAME_LENGTH) {
          res
            .status(400)
            .json({ error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer` });
          return;
        }
        const passwordResult = validatePassword(password);
        if (!passwordResult.ok) {
          res.status(400).json({ error: passwordResult.error });
          return;
        }

        await client.query('BEGIN');

        // Lock the invitation row for the duration of the transaction so
        // two simultaneous accept attempts can't both create users.
        const invResult = await client.query(
          `SELECT id, email, role, expires_at, accepted_at, revoked_at
         FROM user_invitations
         WHERE token_hash = $1
         FOR UPDATE`,
          [hashToken(token)],
        );
        if (invResult.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Invitation not found' });
          return;
        }
        const inv = invResult.rows[0];
        if (inv.accepted_at || inv.revoked_at || new Date(inv.expires_at).getTime() <= Date.now()) {
          await client.query('ROLLBACK');
          res.status(410).json({ error: 'This invitation is no longer valid' });
          return;
        }

        // Race with /api/users POST: another path may have created this
        // email between the create-invitation guard and now.
        const existing = await client.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [
          inv.email,
        ]);
        if (existing.rows.length > 0) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'An account with this email already exists' });
          return;
        }

        const passwordHash = await bcrypt.hash(passwordResult.password, BCRYPT_ROUNDS);
        const userResult = await client.query(
          `INSERT INTO users (email, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, role, is_active`,
          [inv.email, passwordHash, displayName.trim(), inv.role],
        );
        const user = userResult.rows[0];

        await client.query(
          `UPDATE user_invitations
         SET accepted_at = NOW(),
             accepted_user_id = $1
         WHERE id = $2`,
          [user.id, inv.id],
        );

        await client.query('COMMIT');

        req.log.info(
          { event: 'invitation.accept', invitationId: inv.id, userId: user.id, role: user.role },
          'Invitation accepted',
        );

        req.session.regenerate((err) => {
          if (err) {
            req.log.error({ err }, 'Session regeneration failed after invitation accept');
            res.status(500).json({ error: 'Failed to complete sign-up' });
            return;
          }
          req.session.userId = user.id;
          req.session.save((saveErr) => {
            if (saveErr) {
              req.log.error({ err: saveErr }, 'Session save failed after invitation accept');
              res.status(500).json({ error: 'Failed to complete sign-up' });
              return;
            }
            res.status(201).json({
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
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure
        }
        req.log.error({ err: error }, 'Failed to accept invitation');
        res.status(500).json({ error: 'Failed to accept invitation' });
      } finally {
        client.release();
      }
    },
  );

  return router;
}
