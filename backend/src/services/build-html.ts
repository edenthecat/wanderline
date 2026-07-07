// pure HTML transforms used by build-service.ts to turn
// the prebuilt player-app/dist/index.html (or the legacy vite-built
// equivalent) into the file://-ready version that ships in the
// build zip. Extracted into its own module so the rewrite rules
// can be unit-tested directly — build-service.ts imports
// `import.meta.url` at module top-level, which ts-jest's
// `default-esm` preset can't parse, so we'd need to either fix
// the jest config (risky cross-suite churn) or keep these pure
// transforms out of the importing chain. The latter wins.

/**
 * Discriminated by `rewriteForPrebuiltDist` so callers can't end
 * up in nonsense states like "rewrite the title but here's a null"
 * or "don't rewrite but here's the title anyway" — both used to be
 * representable when this was a flat interface, and both were
 * silent no-ops. Now the type system makes the inconsistent combos
 * unrepresentable.
 */
export type PrepareDistHtmlOptions =
  | {
      /**
       * prebuilt-dist fast path. Rewrites the page <title>
       * to the project name AND rewrites absolute `/assets/...`
       * paths to `./assets/...` (vite's `base: './'` setting only
       * helps in the legacy rebuild branch).
       */
      rewriteForPrebuiltDist: true;
      /** Project name, already HTML-escaped. Replaces `<title>...</title>`. */
      title: string;
      /** Story data to inject as window.__WANDERLINE_STORY__. */
      storyData: unknown;
    }
  | {
      /**
       * Legacy rebuild-from-source branch. The scaffold writes the
       * project name into a fresh index.html at build time and
       * vite's `base: './'` produces relative paths, so neither
       * rewrite is needed.
       */
      rewriteForPrebuiltDist: false;
      /** Story data to inject as window.__WANDERLINE_STORY__. */
      storyData: unknown;
    };

/**
 * Pure transform from raw player index.html to the file://-ready
 * version that ships in the build zip.
 *
 * Steps:
 *   1. Strip `crossorigin` and `type="module"` — the built bundle
 *      is an IIFE and file:// can't load ES modules.
 *   2. Add `defer` to every <script> so it runs after the inlined
 *      story-data script.
 *   3. (Prebuilt-dist) Replace <title> with the project name. Uses
 *      a replacer function so $&/$'/$$ in the name don't get
 *      treated as back-references.
 *   4. (Prebuilt-dist) Rewrite absolute `/assets/...` → `./assets/...`.
 *   5. Inject `<script>window.__WANDERLINE_STORY__=...</script>` right
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
  if (options.rewriteForPrebuiltDist) {
    const title = options.title;
    html = html.replace(/<title>[^<]*<\/title>/i, () => `<title>${title}</title>`);
    html = html.replace(/((?:src|href)=)"\/(assets\/[^"]+)"/g, '$1"./$2"');
  }
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
