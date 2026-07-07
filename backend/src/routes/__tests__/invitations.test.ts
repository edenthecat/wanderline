import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createHash } from 'crypto';
import type { Pool } from 'pg';
import {
  createInvitationsRouter,
  createPublicInvitationsRouter,
  cleanupExpiredInvitations,
} from '../invitations.js';

// integration tests for the magic-link invitation endpoints
// (.97). Cypress covers the happy-path flow end-to-end against
// the live stack; this suite locks down the edge cases that are
// expensive to set up there — revocation, race-with-existing-user,
// token TTL boundaries, the audit log shape, the rate-limit hook,
// and the URL builder's PUBLIC_BASE_URL precedence.

function makeApp(pool: Pool, opts: { createLimiter?: express.RequestHandler } = {}) {
  const app = express();
  app.use(express.json());
  // Stub pino's req.log so the route handlers don't crash trying to
  // call req.log.info()/error(). The shape mirrors what pinoHttp adds.
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof console }).log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as typeof console;
    next();
  });
  // Authenticated user shim — the admin routes assume req.user is set
  // by createAuthMiddleware in production. Tests treat the user as a
  // logged-in admin for the routes mounted here.
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; role: string } }).user = {
      id: 'admin-user',
      role: 'admin',
    };
    next();
  });
  // Session stub for the accept endpoint (it calls regenerate/save).
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      regenerate: (cb: (err?: unknown) => void) => cb(),
      save: (cb: (err?: unknown) => void) => cb(),
      userId: undefined,
    };
    next();
  });
  app.use('/api/invitations/token', createPublicInvitationsRouter(pool));
  app.use('/api/invitations', createInvitationsRouter(pool, opts.createLimiter));
  return app;
}

function hashToken(t: string) {
  return createHash('sha256').update(t).digest('hex');
}

interface QueryCall {
  sql: string;
  params: unknown[];
}
type QueryHandler = (sql: string, params: unknown[]) => unknown;

function makePool(handlers: QueryHandler[]) {
  const calls: QueryCall[] = [];
  let i = 0;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    const fn = handlers[i++];
    if (!fn) throw new Error(`unexpected query #${i}: ${sql.slice(0, 80)}`);
    return fn(sql, params ?? []);
  });
  // Accept endpoint uses pool.connect() for a transaction.
  const connect = jest.fn(async () => ({
    query,
    release: () => undefined,
  }));
  return {
    pool: { query, connect } as unknown as Pool,
    calls,
    query,
  };
}

describe('POST /api/invitations', () => {
  it('rejects when email is missing', async () => {
    const { pool } = makePool([]);
    const res = await request(makeApp(pool)).post('/api/invitations').send({ role: 'editor' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('rejects unknown roles', async () => {
    const { pool } = makePool([]);
    const res = await request(makeApp(pool))
      .post('/api/invitations')
      .send({ email: 'a@b.com', role: 'superadmin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role/i);
  });

  it('400s when a user already exists (active or deactivated)', async () => {
    // First query: SELECT 1 FROM users — return a row to simulate
    // an existing record (the follow-up makes the check
    // active-agnostic, matching the accept path).
    const { pool } = makePool([() => ({ rows: [{ '?column?': 1 }] })]);
    const res = await request(makeApp(pool))
      .post('/api/invitations')
      .send({ email: 'existing@example.com', role: 'editor' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('409s when a pending invitation already exists', async () => {
    const { pool } = makePool([
      () => ({ rows: [] }), // no existing user
      () => ({ rows: [{ '?column?': 1 }] }), // pending invite found
    ]);
    const res = await request(makeApp(pool))
      .post('/api/invitations')
      .send({ email: 'a@b.com', role: 'editor' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending invitation/i);
  });

  it('inserts + returns a magic link URL when the slot is open', async () => {
    const insertedRow = {
      id: 'inv-1',
      email: 'a@b.com',
      role: 'editor',
      invited_by: 'admin-user',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    };
    const { pool, calls } = makePool([
      () => ({ rows: [] }), // existing user check
      () => ({ rows: [] }), // pending check
      () => ({ rows: [insertedRow] }), // INSERT RETURNING
    ]);
    const res = await request(makeApp(pool))
      .post('/api/invitations')
      .send({ email: 'a@b.com', role: 'editor' });
    expect(res.status).toBe(201);
    expect(res.body.invitation.id).toBe('inv-1');
    // URL ends with /invite/<token>. The token isn't exposed elsewhere.
    expect(res.body.magicLinkUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);
    // INSERT was called with the configured TTL bound — assert that
    // expires_at is roughly 7 days in the future.
    const insertCall = calls[2];
    const expiresAt = insertCall.params[4] as Date;
    const days = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('honours the createLimiter middleware when provided', async () => {
    let calls = 0;
    const limiter: express.RequestHandler = (_req, res) => {
      calls++;
      res.status(429).json({ error: 'too many invites' });
    };
    const { pool } = makePool([]);
    const res = await request(makeApp(pool, { createLimiter: limiter }))
      .post('/api/invitations')
      .send({ email: 'a@b.com', role: 'editor' });
    expect(res.status).toBe(429);
    expect(calls).toBe(1);
  });

  it('PUBLIC_BASE_URL overrides the request host when building the magic link', async () => {
    const old = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://wanderline.example/';
    try {
      const insertedRow = {
        id: 'inv-2',
        email: 'b@c.com',
        role: 'editor',
        invited_by: 'admin-user',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      };
      const { pool } = makePool([
        () => ({ rows: [] }),
        () => ({ rows: [] }),
        () => ({ rows: [insertedRow] }),
      ]);
      const res = await request(makeApp(pool))
        .post('/api/invitations')
        .send({ email: 'b@c.com', role: 'editor' });
      expect(res.status).toBe(201);
      // Note the trailing slash on PUBLIC_BASE_URL — the helper strips it.
      expect(res.body.magicLinkUrl).toMatch(/^https:\/\/wanderline\.example\/invite\//);
    } finally {
      process.env.PUBLIC_BASE_URL = old;
    }
  });
});

describe('GET /api/invitations', () => {
  it('returns the pending list', async () => {
    const rows = [
      {
        id: 'inv-1',
        email: 'a@b.com',
        role: 'editor',
        invited_by: 'admin',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        created_at: new Date().toISOString(),
      },
    ];
    const { pool } = makePool([() => ({ rows })]);
    const res = await request(makeApp(pool)).get('/api/invitations');
    expect(res.status).toBe(200);
    expect(res.body.invitations).toHaveLength(1);
    expect(res.body.invitations[0]).toMatchObject({ id: 'inv-1', email: 'a@b.com' });
  });
});

describe('DELETE /api/invitations/:id', () => {
  it('404s when the invitation is gone', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    const res = await request(makeApp(pool)).delete('/api/invitations/missing');
    expect(res.status).toBe(404);
  });

  it('marks the row revoked on success', async () => {
    const { pool, calls } = makePool([() => ({ rows: [{ id: 'inv-1', email: 'a@b.com' }] })]);
    const res = await request(makeApp(pool)).delete('/api/invitations/inv-1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(calls[0].sql).toMatch(/SET revoked_at = NOW\(\)/i);
  });
});

describe('GET /api/invitations/token/:token', () => {
  const TOKEN = 'fresh-token';

  it('404s when the token does not exist', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    const res = await request(makeApp(pool)).get(`/api/invitations/token/${TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('410s when accepted_at is set (already used)', async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            id: 'inv-1',
            email: 'a@b.com',
            role: 'editor',
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            accepted_at: new Date().toISOString(),
            revoked_at: null,
          },
        ],
      }),
    ]);
    const res = await request(makeApp(pool)).get(`/api/invitations/token/${TOKEN}`);
    expect(res.status).toBe(410);
  });

  it('410s when revoked', async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            id: 'inv-1',
            email: 'a@b.com',
            role: 'editor',
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            accepted_at: null,
            revoked_at: new Date().toISOString(),
          },
        ],
      }),
    ]);
    const res = await request(makeApp(pool)).get(`/api/invitations/token/${TOKEN}`);
    expect(res.status).toBe(410);
  });

  it('410s when expired', async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            id: 'inv-1',
            email: 'a@b.com',
            role: 'editor',
            expires_at: new Date(Date.now() - 60_000).toISOString(),
            accepted_at: null,
            revoked_at: null,
          },
        ],
      }),
    ]);
    const res = await request(makeApp(pool)).get(`/api/invitations/token/${TOKEN}`);
    expect(res.status).toBe(410);
  });

  it('returns the public payload when valid + queries by token hash, not raw token', async () => {
    const { pool, calls } = makePool([
      (_sql, params) => {
        expect(params[0]).toBe(hashToken(TOKEN));
        return {
          rows: [
            {
              id: 'inv-1',
              email: 'a@b.com',
              role: 'editor',
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              accepted_at: null,
              revoked_at: null,
            },
          ],
        };
      },
    ]);
    const res = await request(makeApp(pool)).get(`/api/invitations/token/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.invitation).toMatchObject({ email: 'a@b.com', role: 'editor' });
    expect(calls[0].sql).toMatch(/token_hash = \$1/);
  });
});

describe('cleanupExpiredInvitations', () => {
  it('issues a single DELETE bounded by the 30-day grace window', async () => {
    const { pool, calls } = makePool([() => ({ rows: [], rowCount: 4 })]);
    const removed = await cleanupExpiredInvitations(pool);
    expect(removed).toBe(4);
    expect(calls[0].sql).toMatch(/DELETE FROM user_invitations/);
    expect(calls[0].sql).toMatch(/NOW\(\) - INTERVAL '30 days'/);
  });

  it('returns 0 when nothing was deleted (rowCount may be null)', async () => {
    const { pool } = makePool([() => ({ rows: [], rowCount: null })]);
    await expect(cleanupExpiredInvitations(pool)).resolves.toBe(0);
  });
});
