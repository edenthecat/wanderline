// pure HTML transforms used by build-service.ts to turn the
// prebuilt player-app/dist/index.html into the file://-ready
// version that ships in the build zip. Extracted into its own
// module so the rewrite rules
// can be unit-tested directly — build-service.ts imports
// `import.meta.url` at module top-level, which ts-jest's
// `default-esm` preset can't parse, so we'd need to either fix
// the jest config (risky cross-suite churn) or keep these pure
// transforms out of the importing chain. The latter wins.

import { DEFAULT_BUILD_LANGUAGE } from './build-language.js';

export interface PrepareDistHtmlOptions {
  /** Project name, already HTML-escaped. Replaces `<title>...</title>`. */
  title: string;
  /** Story data to inject as window.__WANDERLINE_STORY__. */
  storyData: unknown;
  /**
   * BCP-47 tag for the story's language, already normalized by
   * normalizeBuildLanguage. Replaces the player's hardcoded
   * `<html lang="en">`. Defaults to 'en'.
   */
  language?: string;
  /**
   * The author's chrome colour, already validated (see
   * resolveThemeColor in build-manifest.ts). Replaces the player's
   * default `theme-color` meta so the browser chrome and the manifest
   * agree. Left alone when omitted.
   */
  themeColor?: string;
}

/**
 * Set `<html lang>`. Rewrites an existing attribute, or adds one when
 * the source document has none — a document with no `lang` at all is
 * exactly as bad for a screen reader as one with the wrong `lang`.
 * `language` must already be normalized (see build-language.ts).
 *
 * Exported because the preview endpoint serves the same player
 * template from its own renderer (renderPreviewHtml in
 * backend/src/routes/projects-preview.ts) and needs the identical
 * rewrite — the shareable /public-preview link is listener-facing, so
 * a French story announced as English there is the same defect as in
 * the exported build.
 */
export function setHtmlLang(html: string, language: string): string {
  // Both quote styles: missing an existing `lang='en'` would fall
  // through to the add-branch and emit `<html lang="fr" lang='en'>`,
  // where the browser honours the FIRST — so the wrong tag would
  // silently win.
  const withExistingLang = /<html([^>]*?)\slang=("[^"]*"|'[^']*')/i;
  if (withExistingLang.test(html)) {
    return html.replace(
      withExistingLang,
      (_m, before: string) => `<html${before} lang="${language}"`,
    );
  }
  return html.replace(/<html(\s|>)/i, (_m, after: string) => `<html lang="${language}"${after}`);
}

/**
 * Point the `theme-color` meta at the author's colour, adding the meta
 * when the source document has none — otherwise dropping the tag from
 * player-app/index.html would silently reinstate the bug this fixes
 * (browser chrome painted the player's default navy while the manifest
 * carried the author's colour). `themeColor` has already been through
 * the manifest's hex validation, so it can't contain a quote that
 * would break out of the attribute.
 */
function applyThemeColor(html: string, themeColor: string): string {
  const meta = `<meta name="theme-color" content="${themeColor}" />`;
  // `name` is not required to come first. Anchoring on it would miss
  // `<meta content="#1a1a2e" name="theme-color" />` — the shape an
  // attribute-reordering minifier or a hand edit can produce — and
  // fall through to the add-branch, shipping TWO theme-color metas.
  // Browsers honour the first, so the build would quietly revert to
  // the player's default navy: the exact bug this function fixes.
  const existing = /<meta[^>]*\sname="theme-color"[^>]*>/i;
  if (existing.test(html)) return html.replace(existing, () => meta);
  if (!html.includes('</head>')) return html;
  return html.replace('</head>', () => `${meta}\n</head>`);
}

/**
 * Replace the player's generic `<noscript>` with one naming the story,
 * or add one before `</body>` if the source document has none.
 *
 * Exported alongside setHtmlLang for the preview renderer: the
 * shareable /public-preview link is listener-facing, and a listener
 * with scripting off was reading "Wanderline Player" rather than the
 * name of the story they had been sent.
 */
export function setNoscriptFallback(html: string, title: string): string {
  const block = renderNoscriptFallback(title);
  if (/<noscript[\s>]/i.test(html)) {
    return html.replace(/<noscript[\s\S]*?<\/noscript>/i, () => block);
  }
  if (!html.includes('</body>')) return html;
  return html.replace('</body>', () => `${block}\n</body>`);
}

/**
 * The scripting-disabled fallback baked into every build.
 *
 * The player is a single `<div id="root">` filled by React, so with
 * scripting off the reader got a blank white page and no explanation.
 * (This covers scripting being *disabled* only — a `<noscript>` stays
 * hidden when scripting is on and the bundle merely fails to load.)
 *
 * `title` must already be HTML-escaped. It is the story's own title, so
 * it inherits the document's `lang`; the message beneath it is our
 * English text and says so, or a French story's fallback would be read
 * aloud with French phonetics.
 *
 * Styled through the player's stylesheet rather than `style="..."`
 * attributes: the preview endpoint serves this same document under a
 * strict CSP whose `style-src` has no `'unsafe-inline'`, so inline
 * styles are dropped there (see buildPreviewCsp in
 * backend/src/routes/projects-preview.ts). With no stylesheet at all
 * the block still renders as legible default-styled text.
 */
export function renderNoscriptFallback(title: string): string {
  return `<noscript>
      <div class="wl-noscript">
        <div class="wl-noscript-inner">
          <h1>${title}</h1>
          <p lang="en">${PLAYER_NOSCRIPT_MESSAGE}</p>
        </div>
      </div>
    </noscript>`;
}

/** The player's own no-JavaScript message. Kept in step with the copy in player-app/index.html. */
export const PLAYER_NOSCRIPT_MESSAGE =
  'This audio narrative needs JavaScript to play. Turn JavaScript on in your browser settings, then reload this page.';

/**
 * Pure transform from raw player index.html to the file://-ready
 * version that ships in the build zip.
 *
 * Steps:
 *   1. Strip `crossorigin` and `type="module"` — the built bundle
 *      is an IIFE and file:// can't load ES modules.
 *   2. Add `defer` to every <script> so it runs after the inlined
 *      story-data script.
 *   3. Replace <title> with the project name. Uses a replacer
 *      function so $&/$'/$$ in the name don't get treated as
 *      back-references.
 *   4. Rewrite `<html lang>` to the project's language, and the
 *      `theme-color` meta to the author's chrome colour — both
 *      shipped hardcoded ("en", the player's default navy) before,
 *      so a French story announced itself as English and mobile
 *      browser chrome disagreed with the manifest.
 *   5. Replace the `<noscript>` fallback so it names the story.
 *   6. Rewrite absolute `/assets/...` → `./assets/...`.
 *   7. Inject `<script>window.__WANDERLINE_STORY__=...</script>` right
 *      before `</head>`. Escapes `<` (</script> breakout) and U+2028 /
 *      U+2029 (JSON-valid but break JS string literals).
 *
 * Throws if `</head>` is missing — without that anchor we can't
 * inject and the zip would ship a non-functional player.
 */
export function prepareDistHtml(rawHtml: string, options: PrepareDistHtmlOptions): string {
  let html = rawHtml;
  html = html.replace(/ crossorigin/g, '');
  html = html.replace(/ type="module"/g, '');
  html = html.replace(/<script /g, '<script defer ');
  html = html.replace(/<title>[^<]*<\/title>/i, () => `<title>${options.title}</title>`);
  html = setHtmlLang(html, options.language ?? DEFAULT_BUILD_LANGUAGE);
  if (options.themeColor) html = applyThemeColor(html, options.themeColor);
  html = setNoscriptFallback(html, options.title);
  html = html.replace(/((?:src|href)=)"\/(assets\/[^"]+)"/g, '$1"./$2"');
  const storyJsonStr = JSON.stringify(options.storyData)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const storyScript = `<script>window.__WANDERLINE_STORY__=${storyJsonStr};</script>`;
  if (!html.includes('</head>')) {
    throw new Error('Built index.html is missing </head> tag — cannot inject story data');
  }
  // Replacer FUNCTION (not string) so the JSON payload's literal
  // `$&` / `$`` / `$'` / `$1` / `$$` sequences don't get
  // interpreted as back-references by String.replace. A node
  // title or content field containing "$&" would otherwise expand
  // to the entire matched `</head>` and corrupt the inject site.
  return html.replace('</head>', () => `${storyScript}\n</head>`);
}
