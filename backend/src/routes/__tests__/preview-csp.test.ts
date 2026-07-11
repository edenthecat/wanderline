import { jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { mountBuildRoutes } from '../projects-builds.js';
import {
  _resetPreviewCachesForTests,
  buildPreviewCsp,
  generatePreviewNonce,
  renderPreviewHtml,
} from '../projects-preview.js';

// CSP + SRI + XFO + Referrer-Policy behaviour for the
// preview shells. The routes under test share a single template
// path via renderPreviewHtml + applyPreviewHeaders, so exercising
// the build-preview route also validates the live-preview shape.

const FAKE_SRI = 'sha384-fakebundlehashformatchingassertions';
const FAKE_MAIN = 'assets/index-abcdef.js';

let tmpDist: string;
let prevPlayerDist: string | undefined;

beforeAll(() => {
  tmpDist = mkdtempSync(join(tmpdir(), 'wanderline-preview-csp-'));
  mkdirSync(join(tmpDist, 'assets'), { recursive: true });
  writeFileSync(
    join(tmpDist, 'index.html'),
    // Minimal Vite-shaped shell: script + link with ./assets/ prefix,
    // <title>, <head>, <div id="root">. Matches what
    // player-app/scripts/emit-bundle-info.mjs points at.
    `<!doctype html><html><head><title>Player</title><script type="module" crossorigin src="./assets/index-abcdef.js"></script></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(tmpDist, 'assets', 'index-abcdef.js'), '/* fake bundle */');
  writeFileSync(
    join(tmpDist, 'bundle-info.json'),
    JSON.stringify({
      version: '0.1.0-test',
      mainScript: FAKE_MAIN,
      sriAlgorithm: 'sha384',
      sriHash: FAKE_SRI,
      scripts: [{ path: FAKE_MAIN, sriHash: FAKE_SRI, sizeBytes: 12 }],
    }),
  );
  prevPlayerDist = process.env.PLAYER_DIST;
  process.env.PLAYER_DIST = tmpDist;
  _resetPreviewCachesForTests();
});

afterAll(() => {
  process.env.PLAYER_DIST = prevPlayerDist;
  rmSync(tmpDist, { recursive: true, force: true });
  _resetPreviewCachesForTests();
});

describe('buildPreviewCsp', () => {
  it('embeds the nonce into script-src + style-src', () => {
    const csp = buildPreviewCsp('N1');
    expect(csp).toMatch(/script-src 'self' 'nonce-N1'/);
    expect(csp).toMatch(/style-src 'self' 'nonce-N1'/);
  });

  it("denies everything else by default (default-src 'none')", () => {
    expect(buildPreviewCsp('N')).toMatch(/default-src 'none'/);
  });

  it('bans framing, base, form-action, and object plugins', () => {
    const csp = buildPreviewCsp('N');
    // `'self'` — not `'none'` — because the editor's own
    // PreviewTab / ThemeTab embed this response in a same-origin
    // iframe. Cross-origin framing is still blocked.
    expect(csp).toMatch(/frame-ancestors 'self'/);
    expect(csp).not.toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/base-uri 'none'/);
    expect(csp).toMatch(/form-action 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
  });

  it('never emits unsafe-inline for script-src', () => {
    // If someone loosens script-src to unsafe-inline for a "quick fix"
    // — the story-data injection would still run without the nonce
    // and any injected XSS payload would run too. Belt-and-braces.
    expect(buildPreviewCsp('N')).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('allows Google Fonts hosts for style-src + font-src', () => {
    const csp = buildPreviewCsp('N');
    expect(csp).toMatch(/style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    expect(csp).toMatch(/font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  });

  it('allows storage.googleapis.com in media-src so signed-URL audio redirects load', () => {
    // The preview-audio route 307-redirects to a signed
    // https://storage.googleapis.com/... URL when
    // USE_SIGNED_URL_DOWNLOADS=true. CSP evaluates media-src on the
    // redirect target — without this the <audio> element silently
    // fails to load, oncanplaythrough never fires, and the
    // preloader stays stuck on "Preparing..." (DEV-169).
    const csp = buildPreviewCsp('N');
    expect(csp).toMatch(/media-src[^;]*'self'/);
    expect(csp).toMatch(/media-src[^;]*blob:/);
    expect(csp).toMatch(/media-src[^;]*https:\/\/storage\.googleapis\.com/);
  });

  it('allows Google Fonts hosts in connect-src for the <link rel="preconnect"> hints', () => {
    // renderThemeForPreview emits `<link rel="preconnect">` to both
    // hosts. Browsers govern preconnect via connect-src (NOT style /
    // font), so omitting them here would generate console violation
    // reports even though the actual style + font loads succeed
    // through their own directives.
    const csp = buildPreviewCsp('N');
    expect(csp).toMatch(/connect-src[^;]*https:\/\/fonts\.googleapis\.com/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/fonts\.gstatic\.com/);
  });
});

describe('generatePreviewNonce', () => {
  it('returns a base64 string of usable length', () => {
    const n = generatePreviewNonce();
    expect(n.length).toBeGreaterThanOrEqual(22);
    expect(n).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('produces distinct nonces per call', () => {
    // Two callers running back-to-back must not collide — the CSP's
    // whole security value depends on the nonce being unguessable.
    const a = generatePreviewNonce();
    const b = generatePreviewNonce();
    expect(a).not.toBe(b);
  });
});

describe('renderPreviewHtml', () => {
  const story = {
    id: 's1',
    title: 'Test',
    audioBaseUrl: './audio/',
    startNode: 'start',
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [],
        choices: [],
        divert: null,
        tags: [],
        audio: {},
      },
    },
  };

  it('injects a nonce onto the story-data inline script', () => {
    const html = renderPreviewHtml(story, 'T', 'Preview Mode', 'N1');
    expect(html).toMatch(/<script nonce="N1">window\.__WANDERLINE_STORY__=/);
  });

  it('does not leave any inline onclick handlers in the shell', () => {
    // The earlier close button used onclick="window.close()"
    // which CSP script-src can't cover with a nonce. Refactor moved
    // it to a data-attribute + a nonce'd listener.
    const html = renderPreviewHtml(story, 'T', 'Preview Mode', 'N1');
    expect(html).not.toMatch(/onclick=/i);
    expect(html).toMatch(/data-wl-close="1"/);
  });

  it('injects a meta referrer=no-referrer to keep signed URLs off Referer', () => {
    const html = renderPreviewHtml(story, 'T', 'Preview Mode', 'N1');
    expect(html).toMatch(/<meta name="referrer" content="no-referrer">/);
  });

  it('adds SRI + crossorigin to the main script tag from bundle-info', () => {
    const html = renderPreviewHtml(story, 'T', 'Preview Mode', 'N1');
    expect(html).toMatch(
      /<script [^>]*src="\/api\/_player\/index-abcdef\.js"[^>]*integrity="sha384-fakebundlehashformatchingassertions"/,
    );
    // crossorigin present (Vite already emits it; the injector must
    // not strip it).
    expect(html).toMatch(/<script[^>]*crossorigin[^>]*integrity/);
  });

  it('honours an sriOverride from the build row', () => {
    const html = renderPreviewHtml(story, 'T', 'Build #3', 'N1', 'sha384-per-build-recorded-hash');
    expect(html).toMatch(/integrity="sha384-per-build-recorded-hash"/);
    // The current bundle's SRI must NOT appear on the main tag when
    // an override is passed — that would defeat per-build pinning.
    const overrideRe = /<script [^>]*src="\/api\/_player\/[^"]+\.js"[^>]*integrity="([^"]+)"/;
    const match = overrideRe.exec(html);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('sha384-per-build-recorded-hash');
  });

  it('does not double-inject integrity when re-rendering', () => {
    // Defensive against a template that already had an integrity
    // attribute — we strip + reapply so a stale hash can't ride along.
    const html = renderPreviewHtml(story, 'T', 'Preview Mode', 'N1');
    // Only ONE integrity attribute on the whole document.
    expect(html.match(/integrity=/g)?.length ?? 0).toBe(1);
  });

  it('escapes < in the story payload to prevent </script> premature close', () => {
    const evilStory = { ...story, title: '</script><script>alert(1)</script>' };
    const html = renderPreviewHtml(evilStory, 'T', 'Preview Mode', 'N1');
    // The </script> inside the payload must appear escaped.
    const inline = html.split('__WANDERLINE_STORY__=')[1].split('</script>')[0];
    expect(inline).not.toMatch(/<\/script>/i);
    expect(inline).toMatch(/\\u003c/);
  });
});

describe('preview response headers via the build-preview route', () => {
  function makeApp(pool: Pool) {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { log: typeof console }).log = {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      } as unknown as typeof console;
      next();
    });
    const router = express.Router();
    mountBuildRoutes(router, pool);
    app.use('/api/projects', router);
    return app;
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

  const SNAPSHOT = {
    id: 's1',
    title: 'Snap',
    audioBaseUrl: '/api/projects/p1/preview/audio/',
    startNode: 'start',
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [],
        choices: [],
        divert: null,
        tags: [],
        audio: {},
      },
    },
  };

  it('ships strict CSP + XFO + Referrer-Policy + Cache-Control on the build preview', async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            story_snapshot: SNAPSHOT,
            status: 'completed',
            build_number: 1,
            label: null,
            project_name: 'Test',
            player_bundle_sri_hash: null,
          },
        ],
      }),
    ]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/preview');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeTruthy();
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/default-src 'none'/);
    // The nonce embedded in CSP MUST also appear on the story-data
    // script tag — otherwise the browser refuses to run it.
    const nonceMatch = /'nonce-([^']+)'/.exec(csp);
    expect(nonceMatch).not.toBeNull();
    expect(res.text).toContain(`nonce="${nonceMatch![1]}"`);
    // SAMEORIGIN so the editor's PreviewTab iframe can
    // load a same-origin preview response.
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it("prefers the build row's recorded SRI over the current bundle's", async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            story_snapshot: SNAPSHOT,
            status: 'completed',
            build_number: 1,
            label: null,
            project_name: 'Test',
            player_bundle_sri_hash: 'sha384-recorded-per-build',
          },
        ],
      }),
    ]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/preview');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/integrity="sha384-recorded-per-build"/);
    expect(res.text).not.toMatch(/integrity="sha384-fakebundlehashformatchingassertions"/);
  });

  it('falls back to the current bundle SRI when the row has null', async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            story_snapshot: SNAPSHOT,
            status: 'completed',
            build_number: 1,
            label: null,
            project_name: 'Test',
            player_bundle_sri_hash: null,
          },
        ],
      }),
    ]);
    const res = await request(makeApp(pool)).get('/api/projects/p1/builds/b1/preview');
    expect(res.text).toMatch(/integrity="sha384-fakebundlehashformatchingassertions"/);
  });

  it('every response ships a distinct nonce (no reuse across requests)', async () => {
    const { pool } = makePool([
      () => ({
        rows: [
          {
            story_snapshot: SNAPSHOT,
            status: 'completed',
            build_number: 1,
            label: null,
            project_name: 'Test',
            player_bundle_sri_hash: null,
          },
        ],
      }),
      () => ({
        rows: [
          {
            story_snapshot: SNAPSHOT,
            status: 'completed',
            build_number: 1,
            label: null,
            project_name: 'Test',
            player_bundle_sri_hash: null,
          },
        ],
      }),
    ]);
    const app = makeApp(pool);
    const r1 = await request(app).get('/api/projects/p1/builds/b1/preview');
    const r2 = await request(app).get('/api/projects/p1/builds/b1/preview');
    const nonce1 = /'nonce-([^']+)'/.exec(r1.headers['content-security-policy'] as string)![1];
    const nonce2 = /'nonce-([^']+)'/.exec(r2.headers['content-security-policy'] as string)![1];
    expect(nonce1).not.toBe(nonce2);
  });
});
