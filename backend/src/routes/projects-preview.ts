import express, { Router, Request, RequestHandler, Response } from 'express';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { buildStoryData, StoryDataError } from '../services/story-data-builder.js';
import { readPlayerBundleInfo } from '../services/build-service.js';
import {
  getStorage,
  audioKey,
  IMMUTABLE_AUDIO_CACHE_CONTROL,
  useSignedUrlDownloads,
} from '../services/storage.js';
import { renderThemeForPreview, type ThemeConfig } from '../services/theme-render.js';
import { logger } from '../logger.js';

/**
 * Mint a URL-safe crypto-random token for public preview links.
 * 24 bytes = 32 base64url chars; wide enough that guessing costs
 * more than the value of a leaked draft narrative.
 */
export function generatePublicPreviewToken(): string {
  return randomBytes(24).toString('base64url');
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve player-app dist directory — prefer /player-app/dist (Docker) with local fallback
const PLAYER_DIST_DOCKER = '/player-app/dist';
const PLAYER_DIST_LOCAL = join(__dirname, '..', '..', '..', 'player-app', 'dist');

// Resolved lazily so late-built dist dirs are picked up
export function getPlayerDist(): string {
  if (process.env.PLAYER_DIST) return process.env.PLAYER_DIST;
  if (existsSync(PLAYER_DIST_DOCKER)) return PLAYER_DIST_DOCKER;
  return PLAYER_DIST_LOCAL;
}

// Cache the player index.html template on first use
let playerHtmlTemplate: string | null = null;

function getPlayerHtmlTemplate(): string {
  // In development, always re-read to pick up rebuilds
  if (playerHtmlTemplate && process.env.NODE_ENV === 'production') return playerHtmlTemplate;

  const dist = getPlayerDist();
  const indexPath = join(dist, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error(
      `Player app not built. Expected dist at: ${dist}. Run "npm run build" in player-app/`,
    );
  }

  playerHtmlTemplate = readFileSync(indexPath, 'utf-8');
  return playerHtmlTemplate;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * derive the CSP header value that pairs with a rendered
 * preview. The nonce must match every inline <script> and <style>
 * emitted by renderPreviewHtml so those elements execute under a
 * strict CSP with no 'unsafe-inline' script-src escape hatch.
 *
 * Highlights of the policy:
 *   - default-src 'none'  — deny everything unless explicitly allowed
 *   - script-src           — 'self' (player bundle) + this request's nonce
 *   - style-src            — 'self' + nonce + Google Fonts CSS host
 *   - font-src             — 'self' + Google Fonts font host
 *   - img-src              — 'self' + data: (Vite emits data: URIs for
 *                            some tiny icons)
 *   - media-src            — 'self' + blob: (player uses blob URLs
 *                            for cached audio)
 *   - connect-src          — 'self' + storage.googleapis.com so a
 *                            signed-URL redirect from the audio route
 *                            can complete on the direct GCS host
 *   - manifest-src 'self'  — Vite ships a webmanifest link
 *   - frame-ancestors 'self' — the editor's PreviewTab / ThemeTab
 *     embed this response in a same-origin <iframe>. `'none'` (the
 * default) blocked those iframes with a
 *     `Refused to frame … because an ancestor violates the following
 *     CSP directive` error and the preview never rendered. `'self'`
 *     preserves the "no cross-origin embedding" intent (the editor
 *     and the preview endpoint are both on the same origin) while
 *     letting the editor render its own preview.
 *   - base-uri, form-action, object-src all 'none' — no clickjacking
 *     or plugin surface
 */
export function buildPreviewCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    // media-src must include storage.googleapis.com because the
    // preview-audio route (projects-preview.ts) 307-redirects to a
    // signed GCS URL when USE_SIGNED_URL_DOWNLOADS=true. CSP evaluates
    // media-src on the REDIRECT TARGET, not the initial URL, so
    // without this host <audio> silently fails to load, oncanplaythrough
    // doesn't fire on the successful path, and useAudioCache falls
    // through to onerror + exponential backoff (~31s per file at
    // MAX_RETRIES=5). Each preload eventually settles as `status: 'error'`
    // and the preloader completes — but with every audio entry in the
    // failed state, so the player lets the user in with no audio.
    // That's DEV-169.
    "media-src 'self' blob: https://storage.googleapis.com",
    // renderThemeForPreview emits <link rel="preconnect"> to both
    // Google Fonts hosts — preconnect is governed by connect-src (not
    // font-src / style-src), so leaving them out here would emit
    // console violations even though the actual style + font loads
    // still succeed via their own directives.
    "connect-src 'self' https://storage.googleapis.com https://fonts.googleapis.com https://fonts.gstatic.com",
    "manifest-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * SRI hash for the current player bundle. Read from
 * bundle-info.json (produced by player-app/scripts/emit-bundle-info.mjs
 * post-vite-build). Cached at module scope in production so we don't
 * disk-read on every request; re-read in dev so a rebuild flows
 * through without a server restart.
 *
 * Returns null when bundle-info.json is missing or unreadable — the
 * preview renderer then omits the integrity attribute + logs a warn.
 * A missing SRI degrades security but doesn't break the preview.
 */
let cachedBundleSri: string | null | undefined;
function getCurrentBundleSri(): string | null {
  if (cachedBundleSri !== undefined && process.env.NODE_ENV === 'production') {
    return cachedBundleSri;
  }
  const info = readPlayerBundleInfo(getPlayerDist());
  cachedBundleSri = info?.sriHash ?? null;
  if (!cachedBundleSri) {
    logger.warn(
      { playerDist: getPlayerDist() },
      ': bundle-info.json missing or invalid; preview SRI unavailable',
    );
  }
  return cachedBundleSri;
}

/** Test hook — clears the cached SRI so a test can flip bundle state. */
export function _resetPreviewCachesForTests(): void {
  cachedBundleSri = undefined;
  playerHtmlTemplate = null;
}

/**: cryptographically random nonce for a preview response. */
export function generatePreviewNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Build the preview HTML from the player template, injecting the
 * given story data and a header banner. Shared between the live
 * project preview and 's per-build preview so the two stay
 * visually consistent.
 *
 * `bannerLabel` is the human-readable string shown in the banner —
 * e.g. "Preview Mode" for live, "Build #3 (Final cut)" for a
 * snapshot. The Close button closes the tab/window in both cases.
 *
 * takes a per-request `nonce` for the strict CSP. Every
 * inline <script> and <style> we emit gets that nonce attribute so
 * script-src / style-src can drop 'unsafe-inline' in the paired CSP
 * header. `sriOverride` lets the build-preview route pin the SRI to
 * a historical build's recorded hash; live preview passes null and
 * we read the current bundle-info.json.
 */
export function renderPreviewHtml(
  storyData: unknown,
  title: string,
  bannerLabel: string,
  nonce: string,
  sriOverride: string | null = null,
): string {
  let html = getPlayerHtmlTemplate();

  // Rewrite asset paths to use the global player assets route (no auth required)
  // Handle both absolute (/assets/) and relative (./assets/) paths from Vite builds
  html = html.replace(/(?:\.\/assets\/|\/assets\/)/g, '/api/_player/');

  // SRI on the main script tag. Only augment the <script>
  // for the JS bundle — CSS SRI would need an emitter-side hash we
  // don't produce today. Skip silently when we can't identify a hash
  // (dev environments without a bundle-info.json).
  const sriHash = sriOverride ?? getCurrentBundleSri();
  if (sriHash) {
    // Match a `<script ... src=".../api/_player/...js"...>` and inject
    // integrity + crossorigin. Vite already emits crossorigin, but the
    // regex-driven injection is defensive against a Vite config change.
    html = html.replace(
      /<script([^>]*?)\ssrc="(\/api\/_player\/[^"]+\.js)"([^>]*)>/,
      (_match, before, src, after) => {
        // Strip any existing integrity so we don't duplicate.
        const cleanBefore = before.replace(/\s+integrity="[^"]*"/g, '');
        const cleanAfter = after.replace(/\s+integrity="[^"]*"/g, '');
        // Ensure crossorigin is present — SRI on cross-origin scripts
        // requires it, and even same-origin some browsers demand it
        // for the check to run.
        const hasCross = /crossorigin/.test(cleanBefore + cleanAfter);
        const crossAttr = hasCross ? '' : ' crossorigin';
        return `<script${cleanBefore} src="${src}"${cleanAfter}${crossAttr} integrity="${sriHash}">`;
      },
    );
  }

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);

  // no-referrer keeps signed-URL query strings + Idempotency
  // keys from leaking via the Referer header when the story navigates
  // to an external link.
  html = html.replace(/<head>/, `<head>\n    <meta name="referrer" content="no-referrer">`);

  // +: theme injection. Pulls fonts from Google's CDN
  // via <link> and sets CSS variables on :root. The `<style>` block
  // must carry the CSP nonce or it'll be rejected — inject the nonce
  // via a string replace so we don't have to thread it through
  // renderThemeForPreview's signature.
  const theme = (storyData as { settings?: { theme?: ThemeConfig } })?.settings?.theme;
  let themeFragment = renderThemeForPreview(theme);
  if (themeFragment) {
    themeFragment = themeFragment.replace(/<style\b/g, `<style nonce="${nonce}"`);
    html = html.replace('</head>', `${themeFragment}\n</head>`);
  }

  // nonce on the story-data script so it runs under strict CSP.
  const storyJsonStr = JSON.stringify(storyData)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const storyScript = `<script nonce="${nonce}">window.__WANDERLINE_STORY__=${storyJsonStr};</script>`;

  // banner styles moved into a nonce'd <style> block so
  // there's no `style="..."` attribute (which would need 'unsafe-inline'
  // in style-src). Close button uses data-wl-close + a nonce'd listener
  // instead of an inline onclick (which script-src can't cover with a
  // nonce — inline event handlers only run under 'unsafe-inline').
  const bannerStyle = `<style nonce="${nonce}">
.wl-preview-banner{background:#4caf50;color:white;text-align:center;padding:.5rem;font-size:.85rem}
.wl-preview-banner button{background:none;border:none;color:white;cursor:pointer;margin-left:1rem;text-decoration:underline;font:inherit}
</style>`;
  const bannerHtml = `<div class="wl-preview-banner">${escapeHtml(bannerLabel)} <button data-wl-close="1">Close</button></div>`;
  const closeScript = `<script nonce="${nonce}">
document.addEventListener('click',function(e){
  var t=e.target;
  if(t&&t.matches&&t.matches('[data-wl-close]')){window.close();}
});
</script>`;

  if (!html.includes('</head>') || !/<div\s+id="root"/.test(html)) {
    throw new Error('Player template missing expected markers (</head> or <div id="root">)');
  }

  html = html.replace('</head>', `${bannerStyle}\n${storyScript}\n${closeScript}\n</head>`);
  html = html.replace(/<div\s+id="root"[^>]*><\/div>/, `${bannerHtml}\n    <div id="root"></div>`);
  return html;
}

/**
 * apply the preview response headers — CSP + XFO + no-store —
 * consistently across every route that emits a preview. Kept as a
 * standalone helper so build-preview and live-preview routes stay in
 * sync as the policy evolves.
 */
export function applyPreviewHeaders(res: Response, nonce: string): void {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', buildPreviewCsp(nonce));
  // XFO mirrors CSP frame-ancestors for legacy engines that ignore
  // CSP framing. SAMEORIGIN — not DENY — so the editor's PreviewTab
  // / ThemeTab iframes still load (they're on the same origin). See
  // buildPreviewCsp docstring for the context.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Belt-and-braces referrer strip. The <meta> in the shell handles
  // the current document; the header covers redirects/subresources.
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/**
 * Render + respond the preview HTML for a given project. Extracted
 * so the authed `/:id/preview` route and the anonymous
 * `/public-preview/:token` route can share the same rendering path
 * (identical CSP, SRI, banner styling, theme injection). Only the
 * audio base URL and banner label differ between the two callers.
 */
export async function respondWithPreviewHtml(
  pool: Pool,
  projectId: string,
  opts: { audioBaseUrl: string; bannerLabel: string },
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { storyData, project } = await buildStoryData(pool, projectId, {
      audioBaseUrl: opts.audioBaseUrl,
      // Never ship the story password to a browser. The authed route is
      // already behind requireAuth, and the public route is gated
      // server-side before we get here, so by this point the caller is
      // entitled to the story and the password would only be a leak.
      // This is also what removes the gate from the editor preview:
      // with no password in the payload the player renders the story
      // directly instead of walling the author out of their own theme
      // editor.
      passwordExposure: 'omit',
    });
    const projectName = (project as Record<string, unknown>).name as string;
    const nonce = generatePreviewNonce();
    const html = renderPreviewHtml(storyData, `${projectName} - Preview`, opts.bannerLabel, nonce);
    applyPreviewHeaders(res, nonce);
    res.send(html);
  } catch (error) {
    req.log.error({ err: error, projectId }, 'Failed to generate preview');
    if (error instanceof StoryDataError) {
      res.status(error.statusCode).send(error.message);
    } else {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      const message = process.env.NODE_ENV === 'production' ? 'Failed to generate preview' : detail;
      res.status(500).send(message);
    }
  }
}

/**
 * Serve an audio file for a preview. Same 307-to-signed-URL /
 * stream-fallback contract as the authed route; extracted so the
 * anonymous public-preview audio path uses the exact same logic
 * without duplicating the streaming plumbing.
 */
export async function respondWithPreviewAudio(
  pool: Pool,
  projectId: string,
  filename: string,
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const result = await pool.query(
      'SELECT * FROM audio_files WHERE project_id = $1 AND filename = $2',
      [projectId, filename],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Audio file not found' });
      return;
    }

    const file = result.rows[0];
    const key = audioKey(projectId, file.filename);

    if (useSignedUrlDownloads()) {
      try {
        const signedUrl = await getStorage().signedGetUrl(key);
        if (signedUrl) {
          res.setHeader('Cache-Control', 'no-store, private');
          res.redirect(307, signedUrl);
          return;
        }
      } catch (err) {
        req.log.warn(
          { err, projectId, key },
          'signedGetUrl threw for preview audio; falling through to stream',
        );
      }
    }

    let stream: NodeJS.ReadableStream;
    try {
      stream = await getStorage().downloadStream(key);
    } catch (err) {
      req.log.error({ err }, 'Audio file not found in storage');
      res.status(404).json({ error: 'Audio file not found' });
      return;
    }

    res.setHeader('Content-Type', file.mime_type || 'audio/mpeg');
    res.setHeader('Content-Length', file.size_bytes);
    res.setHeader('Cache-Control', IMMUTABLE_AUDIO_CACHE_CONTROL);
    stream.on('error', (err) => {
      req.log.error({ err }, 'Stream error serving preview audio');
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream audio' });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (error) {
    req.log.error({ err: error }, 'Failed to serve preview audio');
    res.status(500).json({ error: 'Failed to serve audio' });
  }
}

export function mountPreviewRoutes(router: Router, pool: Pool): void {
  /**
   * @openapi
   * /projects/{id}/preview:
   *   get:
   *     summary: Render the live project in the player.
   *     description: |
   *       Returns the player HTML with the project's current story
   *       data inlined. Asset URLs are rewritten to /api/_player so
   *       the bundle loads without an auth header.
   *
   *       response ships with a strict CSP (default-src
   *       'none' + explicit allows, no 'unsafe-inline' script-src),
   *       X-Frame-Options: SAMEORIGIN, Referrer-Policy: no-referrer,
   *       and an SRI attribute on the player bundle when a
   *       bundle-info.json is available.: SAMEORIGIN (not
   *       DENY) so the editor's PreviewTab / ThemeTab iframes can
   *       load their same-origin preview response.
   *     tags: [Preview]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Player HTML.
   *         content:
   *           text/html:
   *             schema: { type: string }
   *       404: { description: Project not found. }
   */
  router.get('/:id/preview', async (req: Request, res: Response) => {
    const { id } = req.params;
    await respondWithPreviewHtml(
      pool,
      id,
      {
        audioBaseUrl: `/api/projects/${id}/preview/audio/`,
        bannerLabel: 'Preview Mode',
      },
      req,
      res,
    );
  });

  // Serve audio files for preview
  router.get('/:id/preview/audio/:filename', async (req: Request, res: Response) => {
    const { id, filename } = req.params;
    await respondWithPreviewAudio(pool, id, filename, req, res);
  });

  /**
   * @openapi
   * /projects/{id}/public-preview:
   *   get:
   *     summary: Fetch the current public-preview state for a project.
   *     description: |
   *       Returns `{ enabled, token, url }`. `token` and `url` are
   *       null when the project has never had public preview
   *       enabled, or non-null (the previously minted values) when
   *       it has been enabled and later disabled — a subsequent
   *       enable call restores the same URL.
   *     tags: [Preview]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Current state.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 enabled: { type: boolean }
   *                 token: { type: string, nullable: true }
   *                 url: { type: string, nullable: true }
   *       404: { description: Project not found. }
   */
  router.get('/:id/public-preview', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `SELECT public_preview_enabled, public_preview_token FROM projects WHERE id = $1`,
        [id],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const row = result.rows[0];
      const token: string | null = row.public_preview_token ?? null;
      res.json({
        enabled: !!row.public_preview_enabled,
        token,
        url: token ? `/public-preview/${token}` : null,
      });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to fetch public preview state');
      res.status(500).json({ error: 'Failed to fetch public preview state' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/public-preview:
   *   post:
   *     summary: Enable public preview and return the shareable URL.
   *     description: |
   *       Idempotent. If the project has never had public preview
   *       enabled, a fresh crypto-random token is minted and stored.
   *       If it has been enabled and later disabled, the previously
   *       minted token is preserved and re-enabled; the shared URL
   *       keeps working across on/off cycles unless the caller
   *       explicitly regenerates.
   *     tags: [Preview]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Public preview enabled.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 enabled: { type: boolean }
   *                 token: { type: string }
   *                 url: { type: string, description: Relative path to the public preview. }
   *       404: { description: Project not found. }
   */
  router.post('/:id/public-preview', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      // Race-safe enable via COALESCE + RETURNING. A naive SELECT-
      // then-UPDATE would let two concurrent Enable clicks (or a
      // rapid double-tap) both see token=null, both mint DIFFERENT
      // candidates, and both UPDATE: the client that got its
      // response first walks away holding a token that the second
      // UPDATE overwrote. With COALESCE the existing value always
      // wins if there is one, so a truly-first enable stores the
      // winner's candidate (by row lock) and any concurrent request
      // reads that same value back through RETURNING. Both callers
      // end up with the same URL.
      const candidate = generatePublicPreviewToken();
      const result = await pool.query(
        `UPDATE projects
         SET public_preview_enabled = true,
             public_preview_token = COALESCE(public_preview_token, $2)
         WHERE id = $1
         RETURNING public_preview_token`,
        [id, candidate],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const token: string = result.rows[0].public_preview_token;
      res.json({ enabled: true, token, url: `/public-preview/${token}` });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to enable public preview');
      res.status(500).json({ error: 'Failed to enable public preview' });
    }
  });

  /**
   * @openapi
   * /projects/{id}/public-preview:
   *   delete:
   *     summary: Disable the public preview link.
   *     description: |
   *       Sets `public_preview_enabled = false`. The stored token
   *       is NOT cleared so a subsequent POST re-enables the same
   *       URL; that is intentional (share once, keep sharing). A
   *       future regenerate action would explicitly null the token.
   *     tags: [Preview]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Public preview disabled.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *       404: { description: Project not found. }
   */
  router.delete('/:id/public-preview', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `UPDATE projects
         SET public_preview_enabled = false
         WHERE id = $1
         RETURNING id`,
        [id],
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      // 200 + { success: true } (rather than a bare 204) matches
      // the codebase convention for DELETE endpoints and lets the
      // shared `request` helper JSON-parse the response without
      // special-casing an empty body.
      res.json({ success: true });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to disable public preview');
      res.status(500).json({ error: 'Failed to disable public preview' });
    }
  });
}

/**
 * Mount the anonymous public-preview routes. Wired outside the
 * `/api/*` prefix (see index.ts) so requests never hit the auth
 * middleware. The token is the sole access-control mechanism; a
 * request with a valid token maps to a specific project, and that
 * mapping is the only thing that decides which audio files a
 * request can reach.
 *
 * Per-route rate limiters (optional so tests can skip them) cap a
 * leaked-token scraper before the author notices and disables.
 * Sized in middleware/rate-limit.ts to sit well above any real
 * listener session; runaway hammering fails closed with 429 while
 * normal preload bursts pass through untouched.
 */
/**
 * CSP for the password prompt page.
 *
 * Deliberately NOT buildPreviewCsp: that policy sets `form-action 'none'`
 * (correct for the player, which has no forms), and serving the prompt
 * under it means the browser blocks the password submission outright —
 * the button appears to do nothing. This policy is the preview's minus
 * the directives a static form page has no use for: no script, no
 * media, no fonts, no framing, and `form-action 'self'` so the POST to
 * our own verify route is actually allowed.
 */
export function buildPasswordPromptCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "form-action 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** Response headers for the password prompt: prompt CSP + the usual framing/referrer guards. */
function applyPasswordPromptHeaders(res: Response, nonce: string): void {
  res.setHeader('Content-Security-Policy', buildPasswordPromptCsp(nonce));
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Never let a prompt (or a 401) sit in a cache in front of the real
  // story: the same URL serves different bytes once verified.
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Resolve a public-preview token to its project and, if the author set
 * one, the story password guarding it.
 *
 * Returns null for an unknown or disabled token so callers can 404
 * without distinguishing "no such link" from "link turned off".
 */
export async function lookupPublicPreview(
  pool: Pool,
  token: string,
): Promise<{ projectId: string; password: string | null } | null> {
  const result = await pool.query(
    `SELECT p.id, pset.settings
     FROM projects p
     LEFT JOIN project_settings pset ON p.id = pset.project_id
     WHERE p.public_preview_token = $1 AND p.public_preview_enabled = true`,
    [token],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const raw = settings.password;
  // Treat empty string as "no password" so clearing the field in the
  // settings UI actually unlocks the link instead of creating a gate
  // nobody can satisfy.
  const password = typeof raw === 'string' && raw.length > 0 ? raw : null;
  return { projectId: row.id, password };
}

/**
 * Compare a submitted password against the stored one in constant time.
 *
 * timingSafeEqual requires equal-length buffers, so both sides are copied
 * into zero-padded buffers of the same length and the real lengths are
 * compared separately. The content comparison never short-circuits, which
 * is the property that matters: a guess sharing a prefix with the real
 * password must not take measurably longer than one that doesn't.
 *
 * An earlier version hashed both sides with SHA-256 to normalise length.
 * That worked, but CodeQL reads "value named password flows into a fast
 * hash" as password-hashing-at-rest (js/insufficient-password-hash) and
 * flags it high severity. The padding approach avoids hashing entirely,
 * so the rule no longer misfires and the comparison is unchanged in
 * substance.
 *
 * Worth being straight about the limits: this compares against a password
 * the project stores in plaintext in its settings JSONB, so it is a gate
 * on the request path, not protection at rest. Hashing story passwords at
 * rest is a real improvement but it is entangled with the static export
 * path, which needs the plaintext to embed in story.json.
 */
export function passwordMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  const width = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(width);
  const paddedB = Buffer.alloc(width);
  a.copy(paddedA);
  b.copy(paddedB);
  // Both operands are evaluated: timingSafeEqual runs over the full
  // padded width regardless, and the length check only then rules out
  // the zero-padding collision ("abc" vs "abc\0").
  const sameContent = timingSafeEqual(paddedA, paddedB);
  return sameContent && a.length === b.length;
}

/** Has this session already cleared the gate for this token? */
export function hasVerifiedToken(req: Request, token: string): boolean {
  return req.session?.verifiedPreviewTokens?.includes(token) ?? false;
}

/**
 * The password prompt shown in place of the story.
 *
 * Deliberately a plain server-rendered form with no JavaScript and no
 * story content: it is what an unverified listener gets *instead of*
 * the payload, so there is nothing here worth reading in view-source.
 * The one <style> block carries the request nonce to satisfy the same
 * CSP the preview runs under.
 */
export function renderPasswordPromptHtml(
  nonce: string,
  opts: { token: string; error: boolean },
): string {
  const action = `/public-preview/${encodeURIComponent(opts.token)}/verify`;
  const errorBlock = opts.error ? '<p class="err" role="alert">Incorrect password</p>' : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Password required</title>
    <style nonce="${nonce}">
      body { margin: 0; min-height: 100vh; display: flex; align-items: center;
             justify-content: center; background: #1a1a1a; color: #f5f5f5;
             font-family: system-ui, -apple-system, sans-serif; }
      .card { width: min(360px, 90vw); padding: 2rem; background: #242424;
              border-radius: 12px; text-align: center; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { margin: 0 0 1.25rem; color: #b0b0b0; font-size: 0.9rem; }
      .err { color: #ff6b6b; }
      input, button { width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem;
                      border-radius: 8px; font-size: 1rem; }
      input { border: 1px solid #444; background: #1a1a1a; color: #f5f5f5;
              margin-bottom: 0.75rem; }
      button { border: 0; background: #4ecdc4; color: #10312e; font-weight: 600;
               cursor: pointer; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>This story is password protected</h1>
      <p>Enter the password the author shared with you.</p>
      ${errorBlock}
      <form method="POST" action="${action}">
        <input type="password" name="password" aria-label="Password"
               placeholder="Password" autocomplete="current-password" autofocus />
        <button type="submit">Unlock</button>
      </form>
    </main>
  </body>
</html>`;
}

export function mountPublicPreviewRoutes(
  router: Router,
  pool: Pool,
  opts: {
    htmlLimiter?: RequestHandler;
    audioLimiter?: RequestHandler;
    verifyLimiter?: RequestHandler;
  } = {},
): void {
  const htmlChain = opts.htmlLimiter ? [opts.htmlLimiter] : [];
  const audioChain = opts.audioLimiter ? [opts.audioLimiter] : [];
  const verifyChain = opts.verifyLimiter ? [opts.verifyLimiter] : [];

  /**
   * Handle the password prompt for a protected token.
   *
   * POSTs the password as a normal form submission so the prompt page
   * needs no JavaScript at all, which keeps it inside the same
   * `script-src 'self' 'nonce-…'` CSP the preview uses.
   */
  router.post(
    '/:token/verify',
    ...verifyChain,
    express.urlencoded({ extended: false, limit: '4kb' }),
    async (req: Request, res: Response) => {
      try {
        const { token } = req.params;
        const found = await lookupPublicPreview(pool, token);
        // Same 404 as an unknown token. A protected project and a
        // non-existent one are indistinguishable from outside.
        if (!found) {
          res.setHeader('Cache-Control', 'no-store');
          res.status(404).send('Not found');
          return;
        }
        if (!found.password) {
          // Nothing to verify; send them to the story.
          res.redirect(303, `/public-preview/${encodeURIComponent(token)}`);
          return;
        }
        const submitted = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!passwordMatches(found.password, submitted)) {
          const nonce = generatePreviewNonce();
          applyPasswordPromptHeaders(res, nonce);
          res.status(401).send(renderPasswordPromptHtml(nonce, { token, error: true }));
          return;
        }
        // Record the grant on the session rather than a bearer value in
        // the page, so nothing the listener can read lets them re-mint
        // access for a different token.
        const verified = new Set(req.session?.verifiedPreviewTokens ?? []);
        verified.add(token);
        req.session.verifiedPreviewTokens = [...verified];
        req.session.save((err) => {
          if (err) {
            req.log.error({ err }, 'Failed to persist public-preview verification');
            res.status(500).send('Failed to verify password');
            return;
          }
          res.redirect(303, `/public-preview/${encodeURIComponent(token)}`);
        });
      } catch (error) {
        req.log.error({ err: error }, 'Failed to verify public preview password');
        res.status(500).send('Failed to verify password');
      }
    },
  );

  router.get('/:token', ...htmlChain, async (req: Request, res: Response) => {
    try {
      const { token } = req.params;
      // Single lookup for both the project id and the password, so the
      // gate costs no extra round trip.
      const protection = await lookupPublicPreview(pool, token);
      if (!protection) {
        // no-store on the 404 too: an author's toggle can flip a
        // token from disabled → enabled while a listener still
        // holds a cached negative response. HTTP defaults let 404s
        // sit in browser + proxy caches; without this header a
        // listener sees "Not found" for the length of the shared
        // cache TTL even after the author re-enables.
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).send('Not found');
        return;
      }
      const projectId: string = protection.projectId;

      // Password gate. This has to happen BEFORE respondWithPreviewHtml,
      // not inside the player: the rendered page embeds the entire story
      // graph as JSON, so a client-side gate left the whole story (and,
      // previously, the password itself) sitting in view-source for
      // anyone holding the link. Returning the prompt instead means an
      // unverified listener never receives the story at all.
      if (protection.password && !hasVerifiedToken(req, token)) {
        const nonce = generatePreviewNonce();
        applyPasswordPromptHeaders(res, nonce);
        res.status(401).send(renderPasswordPromptHtml(nonce, { token, error: false }));
        return;
      }

      await respondWithPreviewHtml(
        pool,
        projectId,
        {
          audioBaseUrl: `/public-preview/${token}/audio/`,
          bannerLabel: 'Public Preview',
        },
        req,
        res,
      );
    } catch (error) {
      req.log.error({ err: error }, 'Failed to serve public preview');
      res.status(500).send('Failed to serve preview');
    }
  });

  router.get('/:token/audio/:filename', ...audioChain, async (req: Request, res: Response) => {
    try {
      const { token, filename } = req.params;
      const protection = await lookupPublicPreview(pool, token);
      if (!protection) {
        // Same rationale as the HTML 404 above: don't let a
        // temporarily-disabled token get cached as a permanent
        // negative in a browser or intermediary proxy.
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const projectId: string = protection.projectId;

      // Gate audio on the same session grant as the HTML. Without this
      // the password would only protect the text: audio filenames are
      // guessable enough (and, for anyone who saw the story once,
      // already known), so an unverified listener could stream the
      // whole narration straight from this route.
      if (protection.password && !hasVerifiedToken(req, token)) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(401).json({ error: 'Password required' });
        return;
      }

      await respondWithPreviewAudio(pool, projectId, filename, req, res);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to serve public preview audio');
      res.status(500).json({ error: 'Failed to serve audio' });
    }
  });
}
