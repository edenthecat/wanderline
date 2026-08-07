import { jest } from '@jest/globals';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import type { Pool } from 'pg';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPasswordPromptCsp,
  buildPreviewCsp,
  hasVerifiedToken,
  lookupPublicPreview,
  mountPublicPreviewRoutes,
  passwordMatches,
  renderPasswordPromptHtml,
  _resetPreviewCachesForTests,
} from '../projects-preview.js';

// Coverage for the server-side public-preview password gate.
//
// The property that matters here is NEGATIVE: an unverified listener
// must never receive the story. The old gate lived in the player, which
// meant the entire story graph (and the password itself) shipped inside
// the HTML and the "gate" was a client-side render decision anyone could
// skip with view-source. Several tests below assert on the ABSENCE of
// story content in the response body for that reason; they are the ones
// that would catch a regression back to a cosmetic gate.

const SECRET = 'test-secret-for-public-preview-password';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwx';
const PASSWORD = 'hunter2';
const STORY_TITLE = 'The Lighthouse Keeper';
const STORY_NODE_TEXT = 'You wake to the sound of the foghorn.';

let tmpDist: string;
beforeAll(() => {
  tmpDist = mkdtempSync(join(tmpdir(), 'wanderline-pp-password-'));
  mkdirSync(join(tmpDist, 'assets'), { recursive: true });
  writeFileSync(
    join(tmpDist, 'index.html'),
    `<!doctype html><html><head><title>Player</title><script type="module" crossorigin src="./assets/index-abcdef.js"></script></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(tmpDist, 'assets', 'index-abcdef.js'), '/* fake bundle */');
  process.env.PLAYER_DIST = tmpDist;
  _resetPreviewCachesForTests();
});
afterAll(() => {
  delete process.env.PLAYER_DIST;
  _resetPreviewCachesForTests();
});

function attachLog(app: express.Express) {
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof console }).log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as typeof console;
    next();
  });
}

function makePool(handlers: Array<(sql: string, params: unknown[]) => unknown>) {
  let i = 0;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const fn = handlers[i++];
    if (!fn) throw new Error(`unexpected query #${i}: ${sql.slice(0, 80)}`);
    return fn(sql, params ?? []);
  });
  const connect = jest.fn(async () => ({ query, release: () => undefined }));
  return { pool: { query, connect } as unknown as Pool, query };
}

/** The token→project lookup row, with whatever settings the test needs. */
function lookupRow(settings: Record<string, unknown>) {
  return { rows: [{ id: 'p1', settings }] };
}

/** The five queries buildStoryData issues once the gate lets a request through. */
function storyDataHandlers(): Array<() => unknown> {
  return [
    () => ({
      rows: [
        {
          id: 'p1',
          name: 'My Story',
          story_graph: {
            id: 'sg1',
            title: STORY_TITLE,
            startNode: 'n1',
            nodes: { n1: { id: 'n1', text: STORY_NODE_TEXT, choices: [] } },
          },
          settings: { password: PASSWORD },
        },
      ],
    }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
  ];
}

function makeApp(pool: Pool) {
  const app = express();
  attachLog(app);
  app.use(
    session({
      secret: SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false },
    }),
  );
  const router = express.Router();
  mountPublicPreviewRoutes(router, pool);
  app.use('/public-preview', router);
  return app;
}

describe('passwordMatches', () => {
  it('accepts the exact password', () => {
    expect(passwordMatches('hunter2', 'hunter2')).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(passwordMatches('hunter2', 'hunter3')).toBe(false);
  });

  it('rejects on case and whitespace differences', () => {
    expect(passwordMatches('hunter2', 'Hunter2')).toBe(false);
    expect(passwordMatches('hunter2', ' hunter2')).toBe(false);
    expect(passwordMatches('hunter2', 'hunter2 ')).toBe(false);
  });

  // Comparing raw strings with timingSafeEqual throws when the lengths
  // differ, which would turn a wrong-length guess into a 500 and leak
  // the stored length. Hashing first makes every comparison 32 bytes.
  it('handles length mismatches without throwing', () => {
    expect(() => passwordMatches('short', 'a-considerably-longer-guess')).not.toThrow();
    expect(passwordMatches('short', 'a-considerably-longer-guess')).toBe(false);
    expect(passwordMatches('', '')).toBe(true);
  });

  it('handles non-ascii passwords', () => {
    expect(passwordMatches('pässwörd✓', 'pässwörd✓')).toBe(true);
    expect(passwordMatches('pässwörd✓', 'password')).toBe(false);
  });
});

describe('lookupPublicPreview', () => {
  it('returns null for an unknown or disabled token', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    expect(await lookupPublicPreview(pool, TOKEN)).toBeNull();
  });

  it('returns the project id and password when one is set', async () => {
    const { pool } = makePool([() => lookupRow({ password: PASSWORD })]);
    expect(await lookupPublicPreview(pool, TOKEN)).toEqual({
      projectId: 'p1',
      password: PASSWORD,
    });
  });

  it('reports no password when settings omit one', async () => {
    const { pool } = makePool([() => lookupRow({})]);
    expect(await lookupPublicPreview(pool, TOKEN)).toEqual({ projectId: 'p1', password: null });
  });

  it('reports no password when the project has no settings row at all', async () => {
    const { pool } = makePool([() => ({ rows: [{ id: 'p1', settings: null }] })]);
    expect(await lookupPublicPreview(pool, TOKEN)).toEqual({ projectId: 'p1', password: null });
  });

  // Clearing the password field in the settings UI stores '', not null.
  // Treating that as a live password would strand the author behind a
  // gate that no input can satisfy.
  it('treats an empty-string password as no password', async () => {
    const { pool } = makePool([() => lookupRow({ password: '' })]);
    expect(await lookupPublicPreview(pool, TOKEN)).toEqual({ projectId: 'p1', password: null });
  });

  it('ignores a non-string password value', async () => {
    const { pool } = makePool([() => lookupRow({ password: 12345 })]);
    expect(await lookupPublicPreview(pool, TOKEN)).toEqual({ projectId: 'p1', password: null });
  });
});

describe('hasVerifiedToken', () => {
  it('is false with no session', () => {
    expect(hasVerifiedToken({} as never, TOKEN)).toBe(false);
  });

  it('is false when the session has verified nothing', () => {
    expect(hasVerifiedToken({ session: {} } as never, TOKEN)).toBe(false);
  });

  it('is true only for the exact token that was verified', () => {
    const req = { session: { verifiedPreviewTokens: [TOKEN] } } as never;
    expect(hasVerifiedToken(req, TOKEN)).toBe(true);
    expect(hasVerifiedToken(req, 'some-other-token')).toBe(false);
  });
});

describe('renderPasswordPromptHtml', () => {
  it('posts to the token-scoped verify route and carries the nonce', () => {
    const html = renderPasswordPromptHtml('NONCE123', { token: TOKEN, error: false });
    expect(html).toContain(`action="/public-preview/${TOKEN}/verify"`);
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html).toContain('name="password"');
  });

  it('shows an error only when asked to', () => {
    expect(renderPasswordPromptHtml('n', { token: TOKEN, error: false })).not.toContain(
      'Incorrect password',
    );
    expect(renderPasswordPromptHtml('n', { token: TOKEN, error: true })).toContain(
      'Incorrect password',
    );
  });

  // The prompt is what an unverified listener gets INSTEAD of the
  // story, so it must not ship any script the CSP would have to widen
  // for, and must not contain story content.
  it('contains no script tag', () => {
    const html = renderPasswordPromptHtml('n', { token: TOKEN, error: true });
    expect(html).not.toMatch(/<script/i);
  });

  it('percent-encodes the token in the form action', () => {
    const html = renderPasswordPromptHtml('n', { token: 'a/b"c', error: false });
    expect(html).toContain('action="/public-preview/a%2Fb%22c/verify"');
    expect(html).not.toContain('action="/public-preview/a/b"c/verify"');
  });
});

describe('password prompt CSP', () => {
  // The prompt is a form page, and the player's CSP sets
  // `form-action 'none'` because the player has no forms. Serving the
  // prompt under that policy makes the browser block the submission and
  // the Unlock button silently does nothing — a failure supertest
  // cannot see, because it does not enforce CSP.
  it("allows the prompt's own form to submit", () => {
    const csp = buildPasswordPromptCsp('n');
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("form-action 'none'");
  });

  it("is not the player's CSP, which would block the form", () => {
    expect(buildPreviewCsp('n')).toContain("form-action 'none'");
    expect(buildPasswordPromptCsp('n')).not.toBe(buildPreviewCsp('n'));
  });

  it('carries the nonce that the prompt style block uses', () => {
    expect(buildPasswordPromptCsp('abc123')).toContain("style-src 'nonce-abc123'");
  });

  // The prompt has no script of its own, so it should not grant any.
  it('grants no script source', () => {
    expect(buildPasswordPromptCsp('n')).not.toContain('script-src');
    expect(buildPasswordPromptCsp('n')).toContain("default-src 'none'");
  });

  it('is the policy actually sent with the prompt response', async () => {
    const { pool } = makePool([() => lookupRow({ password: PASSWORD })]);
    const res = await request(makeApp(pool)).get(`/public-preview/${TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.headers['content-security-policy']).toContain("form-action 'self'");
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('sends it on the wrong-password re-render too', async () => {
    const { pool } = makePool([() => lookupRow({ password: PASSWORD })]);
    const res = await request(makeApp(pool))
      .post(`/public-preview/${TOKEN}/verify`)
      .type('form')
      .send({ password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.headers['content-security-policy']).toContain("form-action 'self'");
  });
});

describe('GET /public-preview/:token — password gate', () => {
  it('serves the story when the project has no password', async () => {
    const { pool } = makePool([() => lookupRow({}), ...storyDataHandlers()]);
    const res = await request(makeApp(pool)).get(`/public-preview/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(STORY_TITLE);
  });

  it('returns 401 and the prompt when a password is set and the session is unverified', async () => {
    const { pool } = makePool([() => lookupRow({ password: PASSWORD })]);
    const res = await request(makeApp(pool)).get(`/public-preview/${TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.text).toContain('password protected');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  // The regression guard for the original bug: no story content and no
  // password anywhere in the bytes an unverified listener receives.
  it('leaks neither the story nor the password to an unverified listener', async () => {
    const { pool } = makePool([() => lookupRow({ password: PASSWORD })]);
    const res = await request(makeApp(pool)).get(`/public-preview/${TOKEN}`);
    expect(res.text).not.toContain(PASSWORD);
    expect(res.text).not.toContain(STORY_TITLE);
    expect(res.text).not.toContain(STORY_NODE_TEXT);
  });

  it('never queries the story graph for an unverified listener', async () => {
    const { pool, query } = makePool([() => lookupRow({ password: PASSWORD })]);
    await request(makeApp(pool)).get(`/public-preview/${TOKEN}`);
    // Exactly one query: the token lookup. buildStoryData never runs.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown token without revealing whether it was protected', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    const res = await request(makeApp(pool)).get(`/public-preview/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('POST /public-preview/:token/verify', () => {
  it('rejects a wrong password with 401 and re-renders the prompt with an error', async () => {
    const { pool } = makePool([() => lookupRow({ password: PASSWORD })]);
    const res = await request(makeApp(pool))
      .post(`/public-preview/${TOKEN}/verify`)
      .type('form')
      .send({ password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Incorrect password');
    expect(res.text).not.toContain(PASSWORD);
  });

  it('rejects a missing password field', async () => {
    const { pool } = makePool([() => lookupRow({ password: PASSWORD })]);
    const res = await request(makeApp(pool)).post(`/public-preview/${TOKEN}/verify`).type('form');
    expect(res.status).toBe(401);
  });

  it('redirects to the story and sets a session cookie on the correct password', async () => {
    const { pool } = makePool([() => lookupRow({ password: PASSWORD })]);
    const res = await request(makeApp(pool))
      .post(`/public-preview/${TOKEN}/verify`)
      .type('form')
      .send({ password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/public-preview/${TOKEN}`);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('404s an unknown token', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    const res = await request(makeApp(pool))
      .post(`/public-preview/${TOKEN}/verify`)
      .type('form')
      .send({ password: PASSWORD });
    expect(res.status).toBe(404);
  });

  it('redirects straight through when the project has no password', async () => {
    const { pool } = makePool([() => lookupRow({})]);
    const res = await request(makeApp(pool))
      .post(`/public-preview/${TOKEN}/verify`)
      .type('form')
      .send({ password: 'anything' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/public-preview/${TOKEN}`);
  });
});

describe('verify → story round trip', () => {
  it('serves the story on the next GET once the session is verified', async () => {
    const { pool } = makePool([
      () => lookupRow({ password: PASSWORD }), // verify lookup
      () => lookupRow({ password: PASSWORD }), // subsequent GET lookup
      ...storyDataHandlers(),
    ]);
    const app = makeApp(pool);
    const agent = request.agent(app);

    const verify = await agent
      .post(`/public-preview/${TOKEN}/verify`)
      .type('form')
      .send({ password: PASSWORD });
    expect(verify.status).toBe(303);

    const story = await agent.get(`/public-preview/${TOKEN}`);
    expect(story.status).toBe(200);
    expect(story.text).toContain(STORY_TITLE);
  });

  // A grant is per-token. Verifying story A must not open story B.
  it('does not carry the grant to a different token', async () => {
    const otherToken = 'tok_zzzzzzzzzzzzzzzzzzzzzzzz';
    const { pool } = makePool([
      () => lookupRow({ password: PASSWORD }), // verify TOKEN
      () => lookupRow({ password: 'different' }), // GET otherToken
    ]);
    const app = makeApp(pool);
    const agent = request.agent(app);

    await agent.post(`/public-preview/${TOKEN}/verify`).type('form').send({ password: PASSWORD });
    const other = await agent.get(`/public-preview/${otherToken}`);
    expect(other.status).toBe(401);
    expect(other.text).toContain('password protected');
  });

  // The password shipping to the client is exactly what made the old
  // gate decorative; assert it is gone even on the authorised path.
  it('omits the password from the story payload even after verifying', async () => {
    const { pool } = makePool([
      () => lookupRow({ password: PASSWORD }),
      () => lookupRow({ password: PASSWORD }),
      ...storyDataHandlers(),
    ]);
    const agent = request.agent(makeApp(pool));
    await agent.post(`/public-preview/${TOKEN}/verify`).type('form').send({ password: PASSWORD });
    const story = await agent.get(`/public-preview/${TOKEN}`);
    expect(story.status).toBe(200);
    expect(story.text).not.toContain(PASSWORD);
  });
});

describe('GET /public-preview/:token/audio/:filename — password gate', () => {
  it('401s audio for an unverified listener on a protected project', async () => {
    const { pool } = makePool([() => lookupRow({ password: PASSWORD })]);
    const res = await request(makeApp(pool)).get(`/public-preview/${TOKEN}/audio/n1.mp3`);
    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('does not query the audio table for an unverified listener', async () => {
    const { pool, query } = makePool([() => lookupRow({ password: PASSWORD })]);
    await request(makeApp(pool)).get(`/public-preview/${TOKEN}/audio/n1.mp3`);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('404s audio for an unknown token', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    const res = await request(makeApp(pool)).get(`/public-preview/${TOKEN}/audio/n1.mp3`);
    expect(res.status).toBe(404);
  });
});
