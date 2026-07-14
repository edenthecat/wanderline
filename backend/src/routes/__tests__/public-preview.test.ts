import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import type { Pool } from 'pg';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generatePublicPreviewToken,
  mountPreviewRoutes,
  mountPublicPreviewRoutes,
  _resetPreviewCachesForTests,
} from '../projects-preview.js';
import {
  _setStorageForTests,
  resetStorageForTests,
  type ObjectStorage,
} from '../../services/storage.js';

// Coverage for the public-preview slice.
//
// Three surfaces:
//   1. Token generation: crypto-random, URL-safe, wide enough that
//      guessing costs more than the value of a leaked draft.
//   2. Enable/disable endpoints: idempotent enable, disable
//      preserves the token, disabled 404s the anonymous URL.
//   3. Anonymous HTML + audio routes: token maps to a project only
//      when public_preview_enabled = true.

// Set up a minimal player-app dist so renderPreviewHtml has a template.
let tmpDist: string;
beforeAll(() => {
  tmpDist = mkdtempSync(join(tmpdir(), 'wanderline-public-preview-'));
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

describe('generatePublicPreviewToken', () => {
  it('emits a URL-safe base64url token of length 32', () => {
    const t = generatePublicPreviewToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBe(32);
  });

  it('does not repeat across many mints (unguessability sanity)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generatePublicPreviewToken());
    expect(seen.size).toBe(1000);
  });
});

describe('POST /api/projects/:id/public-preview — enable', () => {
  it('mints a fresh token when none exists and stores it', async () => {
    const { pool, query } = makePool([
      // SELECT public_preview_token
      () => ({ rows: [{ public_preview_token: null }] }),
      // UPDATE ... RETURNING nothing
      () => ({ rows: [], rowCount: 1 }),
    ]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPreviewRoutes(router, pool);
    app.use('/api/projects', router);

    const res = await request(app).post('/api/projects/p1/public-preview');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(res.body.url).toBe(`/public-preview/${res.body.token}`);

    // Update was called with the same token we returned.
    const updateCall = query.mock.calls[1] as unknown[];
    const updateParams = updateCall[1] as unknown[];
    expect(updateParams[1]).toBe(res.body.token);
  });

  it('reuses the existing token on re-enable (share once, keep sharing)', async () => {
    const stored = 'existing-token-preserved-across-cycles';
    const { pool } = makePool([
      () => ({ rows: [{ public_preview_token: stored }] }),
      () => ({ rows: [], rowCount: 1 }),
    ]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPreviewRoutes(router, pool);
    app.use('/api/projects', router);

    const res = await request(app).post('/api/projects/p1/public-preview');

    expect(res.status).toBe(200);
    expect(res.body.token).toBe(stored);
    expect(res.body.url).toBe(`/public-preview/${stored}`);
  });

  it('404s when the project does not exist', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPreviewRoutes(router, pool);
    app.use('/api/projects', router);

    const res = await request(app).post('/api/projects/ghost/public-preview');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/projects/:id/public-preview — disable', () => {
  it('flips the flag and returns 204 without touching the token', async () => {
    const { pool, query } = makePool([
      // UPDATE ... RETURNING id
      () => ({ rows: [{ id: 'p1' }], rowCount: 1 }),
    ]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPreviewRoutes(router, pool);
    app.use('/api/projects', router);

    const res = await request(app).delete('/api/projects/p1/public-preview');
    expect(res.status).toBe(204);

    const sql = (query.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toMatch(/public_preview_enabled = false/);
    expect(sql).not.toMatch(/public_preview_token/);
  });

  it('404s when the project does not exist', async () => {
    const { pool } = makePool([() => ({ rows: [], rowCount: 0 })]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPreviewRoutes(router, pool);
    app.use('/api/projects', router);

    const res = await request(app).delete('/api/projects/ghost/public-preview');
    expect(res.status).toBe(404);
  });
});

describe('GET /public-preview/:token — anonymous HTML', () => {
  const validToken = 'valid-token-string-abc123';

  it('renders the player HTML when the token matches an enabled project', async () => {
    // Full buildStoryData query sequence:
    //   0. token lookup (this route's own)
    //   1. project + story_graph + settings
    //   2. audio_files
    //   3. node_audio_assignments
    //   4. node_metadata
    //   5. characters
    const { pool } = makePool([
      () => ({ rows: [{ id: 'p1' }] }),
      () => ({
        rows: [
          {
            id: 'p1',
            name: 'My Story',
            story_graph: { title: 'My Story', nodes: {}, initialNode: null },
            settings: {},
          },
        ],
      }),
      () => ({ rows: [] }),
      () => ({ rows: [] }),
      () => ({ rows: [] }),
      () => ({ rows: [] }),
    ]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPublicPreviewRoutes(router, pool);
    app.use('/public-preview', router);

    const res = await request(app).get(`/public-preview/${validToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/Public Preview/);
    // Audio URLs baked in should point back at the token-scoped path
    // so the anonymous player can fetch its own audio.
    expect(res.text).toMatch(new RegExp(`/public-preview/${validToken}/audio/`));
  });

  it('404s when the token is unknown', async () => {
    const { pool } = makePool([() => ({ rows: [] })]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPublicPreviewRoutes(router, pool);
    app.use('/public-preview', router);

    const res = await request(app).get('/public-preview/unknown-token');
    expect(res.status).toBe(404);
  });

  it('404s when the token is known but public preview is disabled', async () => {
    // The SQL filters on public_preview_enabled = true, so a
    // disabled project simply returns zero rows — same behaviour
    // as an unknown token. Assert the disabled path 404s to pin
    // this contract against a future refactor.
    const { pool } = makePool([() => ({ rows: [] })]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPublicPreviewRoutes(router, pool);
    app.use('/public-preview', router);

    const res = await request(app).get(`/public-preview/${validToken}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /public-preview/:token/audio/:filename — anonymous audio', () => {
  const validToken = 'valid-token-string-abc123';

  afterEach(() => {
    resetStorageForTests();
    delete process.env.USE_SIGNED_URL_DOWNLOADS;
  });

  it('streams the audio file when the token maps to an enabled project', async () => {
    _setStorageForTests({
      uploadFile: (() => {
        throw new Error('unused');
      }) as ObjectStorage['uploadFile'],
      downloadStream: (async () =>
        Readable.from(['audio-bytes'])) as ObjectStorage['downloadStream'],
      delete: (() => {
        throw new Error('unused');
      }) as ObjectStorage['delete'],
      exists: (() => {
        throw new Error('unused');
      }) as ObjectStorage['exists'],
      size: (() => {
        throw new Error('unused');
      }) as ObjectStorage['size'],
      signedGetUrl: (async () => null) as ObjectStorage['signedGetUrl'],
    });

    const { pool } = makePool([
      // Token lookup
      () => ({ rows: [{ id: 'p1' }] }),
      // audio_files lookup
      () => ({
        rows: [
          {
            filename: 'clip.mp3',
            mime_type: 'audio/mpeg',
            size_bytes: 11,
          },
        ],
      }),
    ]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPublicPreviewRoutes(router, pool);
    app.use('/public-preview', router);

    const res = await request(app)
      .get(`/public-preview/${validToken}/audio/clip.mp3`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
    expect((res.body as Buffer).toString('utf8')).toBe('audio-bytes');
  });

  it('404s when the token is unknown (never touches storage)', async () => {
    let storageTouched = false;
    _setStorageForTests({
      uploadFile: (() => {
        storageTouched = true;
        throw new Error();
      }) as ObjectStorage['uploadFile'],
      downloadStream: (() => {
        storageTouched = true;
        throw new Error();
      }) as ObjectStorage['downloadStream'],
      delete: (() => {
        storageTouched = true;
        throw new Error();
      }) as ObjectStorage['delete'],
      exists: (() => {
        storageTouched = true;
        throw new Error();
      }) as ObjectStorage['exists'],
      size: (() => {
        storageTouched = true;
        throw new Error();
      }) as ObjectStorage['size'],
      signedGetUrl: (() => {
        storageTouched = true;
        throw new Error();
      }) as ObjectStorage['signedGetUrl'],
    });

    const { pool } = makePool([() => ({ rows: [] })]);
    const app = express();
    attachLog(app);
    const router = express.Router();
    mountPublicPreviewRoutes(router, pool);
    app.use('/public-preview', router);

    const res = await request(app).get('/public-preview/unknown-token/audio/anything.mp3');
    expect(res.status).toBe(404);
    expect(storageTouched).toBe(false);
  });
});
