import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'node:crypto';
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
    try {
      const { id } = req.params;

      const { storyData, project } = await buildStoryData(pool, id, {
        audioBaseUrl: `/api/projects/${id}/preview/audio/`,
      });

      const projectName = (project as Record<string, unknown>).name as string;
      const nonce = generatePreviewNonce();
      const html = renderPreviewHtml(storyData, `${projectName} - Preview`, 'Preview Mode', nonce);
      applyPreviewHeaders(res, nonce);
      res.send(html);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to generate preview');
      if (error instanceof StoryDataError) {
        res.status(error.statusCode).send(error.message);
      } else {
        const detail = error instanceof Error ? error.message : 'Unknown error';
        const message =
          process.env.NODE_ENV === 'production' ? 'Failed to generate preview' : detail;
        res.status(500).send(message);
      }
    }
  });

  // Serve audio files for preview
  router.get('/:id/preview/audio/:filename', async (req: Request, res: Response) => {
    try {
      const { id, filename } = req.params;

      const result = await pool.query(
        'SELECT * FROM audio_files WHERE project_id = $1 AND filename = $2',
        [id, filename],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Audio file not found' });
        return;
      }

      const file = result.rows[0];
      const key = audioKey(id, file.filename);

      // signed-URL 307 for preview audio. Same
      // contract as build download (#122): flag-gated + backend-
      // supported (GCS) → 307 → signed URL; flag-off / null / throw
      // → fall through to the streaming path. Cache-Control: no-store
      // on the 307 itself because a signed URL is a per-request
      // capability that must not be reused across users.
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
            { err, projectId: id, key },
            'signedGetUrl threw for preview audio — falling through to stream',
          );
        }
      }

      // Open the stream first so we don't set audio headers on a 404 response.
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
      // content-addressed immutable cache. `private` because
      // these responses are auth-gated — see IMMUTABLE_AUDIO_CACHE_CONTROL.
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
  });
}
