import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';

// Build a small app fresh per test so the limiter's in-memory store starts
// clean each time. Uses the same baseOptions/handler shape as production.
function buildLimitedApp(limit: number, windowMs = 60_000) {
  const app = express();
  app.set('trust proxy', false);

  const limiter = rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: 'Too many requests, please slow down.',
        retryAfter: Math.ceil(options.windowMs / 1000),
      });
    },
  });
  app.use(limiter);
  app.get('/', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rate limiter', () => {
  it('allows requests up to the limit', async () => {
    const app = buildLimitedApp(3);
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 with retryAfter once the limit is exceeded', async () => {
    const app = buildLimitedApp(2);
    await request(app).get('/');
    await request(app).get('/');
    const blocked = await request(app).get('/');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toHaveProperty('error');
    expect(blocked.body).toHaveProperty('retryAfter');
    expect(typeof blocked.body.retryAfter).toBe('number');
  });

  it('uses the standard RateLimit header (draft-8), not X-RateLimit-*', async () => {
    const app = buildLimitedApp(5);
    const res = await request(app).get('/');
    // draft-8 emits a single combined RateLimit header
    expect(res.headers['ratelimit']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
