// theme rendering — turn a project's stored theme object
// into the HTML head fragments that the preview + build pipelines
// inject. Live preview pulls fonts from Google's CDN via a <link>;
// the build pipeline downloads the woff2 files into public/fonts/
// so the bundle works offline.

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';
import { COMPONENT_SPECS, componentVarName, type ComponentTheming } from './theme-components.js';

export interface ThemeVariables {
  pageBackground?: string;
  cardBackground?: string;
  textColor?: string;
  accentColor?: string;
  headingColor?: string;
  chromeColor?: string;
  // follow-up: recolors every iconoir SVG in the player UI.
  // The icon wrappers carry the `wl-icon` class which reads from
  // --wl-icon-color, defaulting to currentColor when unset.
  iconColor?: string;
}

export interface ThemeConfig {
  variables?: ThemeVariables;
  bodyFont?: string;
  bodyFontWeights?: string[];
  headingFont?: string;
  headingFontWeights?: string[];
  customCss?: string;
  // per-component overrides. Each key is a ComponentId; the
  // value is a record of property → string. Unset properties fall
  // back through the player's `var(--wl-...,  fallback)` chain.
  components?: ComponentTheming;
}

// CSS custom-property names the player consumes. Stays in sync with
// player-app/src/App.tsx's styles object — adding a knob here requires
// reading the matching `var(--wl-...)` in the player.
const VARIABLE_PROPERTY_MAP: Record<keyof ThemeVariables, string> = {
  pageBackground: '--wl-page-bg',
  cardBackground: '--wl-card-bg',
  textColor: '--wl-text',
  accentColor: '--wl-accent',
  headingColor: '--wl-heading',
  chromeColor: '--wl-chrome',
  iconColor: '--wl-icon-color',
};

function escapeCssValue(raw: string): string {
  // Stored values are author input — strip control chars + angle
  // brackets so a hostile theme can't break out of the <style> we
  // inject. The literal control-byte range is defence-in-depth;
  // suppress the eslint rule that flags any regex containing it.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f]/g, '').replace(/[<>]/g, '');
}

function escapeFontFamily(name: string): string {
  // Family names go into a Google Fonts URL + a CSS string. Strip
  // everything but letters / digits / spaces / common punctuation.
  return name.replace(/[^A-Za-z0-9 +\-_]/g, '').trim();
}

function fontFamilyValue(name: string): string {
  // Quote names containing spaces so they parse as a single token.
  const clean = escapeFontFamily(name);
  if (!clean) return '';
  return /\s/.test(clean) ? `'${clean}'` : clean;
}

function fontWeightsParam(weights: string[] | undefined): string {
  if (!weights || weights.length === 0) return '';
  const valid = weights.filter((w) => /^\d+$/.test(String(w)));
  if (valid.length === 0) return '';
  return `:wght@${valid.join(';')}`;
}

// Build the Google Fonts CSS URL for the configured fonts. Returns
// null when no fonts are set, in which case the caller skips the link.
export function googleFontsLinkUrl(theme: ThemeConfig | undefined): string | null {
  if (!theme) return null;
  const families: string[] = [];
  if (theme.bodyFont) {
    const name = escapeFontFamily(theme.bodyFont);
    if (name) families.push(`${name.replace(/ /g, '+')}${fontWeightsParam(theme.bodyFontWeights)}`);
  }
  if (theme.headingFont && theme.headingFont !== theme.bodyFont) {
    const name = escapeFontFamily(theme.headingFont);
    if (name)
      families.push(`${name.replace(/ /g, '+')}${fontWeightsParam(theme.headingFontWeights)}`);
  }
  if (families.length === 0) return null;
  return `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join('&')}&display=swap`;
}

// Generate the inline CSS payload the preview / build injects after
// the fonts link. Sets variables on :root, configures the body /
// heading font-family vars, then appends customCss verbatim.
export function renderThemeCss(theme: ThemeConfig | undefined): string {
  if (!theme) return '';
  const variableLines: string[] = [];
  const vars = theme.variables ?? {};
  for (const [key, prop] of Object.entries(VARIABLE_PROPERTY_MAP) as Array<
    [keyof ThemeVariables, string]
  >) {
    const value = vars[key];
    if (typeof value === 'string' && value.trim()) {
      variableLines.push(`  ${prop}: ${escapeCssValue(value.trim())};`);
    }
  }
  const bodyFamily = theme.bodyFont ? fontFamilyValue(theme.bodyFont) : '';
  const headingFamily = theme.headingFont ? fontFamilyValue(theme.headingFont) : '';
  if (bodyFamily) variableLines.push(`  --wl-font-body: ${bodyFamily};`);
  if (headingFamily) variableLines.push(`  --wl-font-heading: ${headingFamily};`);

  // per-component overrides. For each component in
  // COMPONENT_SPECS, emit `--wl-<componentId>-<prop>` if the author
  // set a value. Unset properties stay out of the block and the
  // player's CSS falls back through the spec's `var(...)` chain.
  const components = theme.components ?? {};
  for (const spec of COMPONENT_SPECS) {
    const overrides = components[spec.id];
    if (!overrides) continue;
    for (const prop of spec.props) {
      const raw = overrides[prop.key];
      if (typeof raw === 'string' && raw.trim()) {
        const name = componentVarName(spec.id, prop.key);
        variableLines.push(`  ${name}: ${escapeCssValue(raw.trim())};`);
      }
    }
  }

  const blocks: string[] = [];
  if (variableLines.length > 0) {
    blocks.push(`:root {\n${variableLines.join('\n')}\n}`);
  }
  if (theme.customCss && theme.customCss.trim()) {
    // Strip </style...> from author input so we can't be tricked into
    // breaking out of the embedded <style> block. HTML5 tokenizes an
    // end-tag as `</` + tagname + zero-or-more whitespace + optional
    // attributes + `>`, so the previous exact-`</style>` match let
    // `</style   >`, `</style\n>`, and `</STYLE >` through and closed
    // the block. Match the tokenizer's grammar instead of the literal
    // string. Same fragment is written unchanged into the built game's
    // dist/index.html (build-service.ts), where there is no CSP to
    // catch a script that slips past this filter.
    blocks.push(theme.customCss.replace(/<\/style(?=[\s/>])[\s\S]*?>/gi, ''));
  }
  return blocks.join('\n\n');
}

// Compose the <head> fragments for the live preview path. Returns
// pre-built HTML so the preview renderer just splices it in.
export function renderThemeForPreview(theme: ThemeConfig | undefined): string {
  if (!theme) return '';
  const parts: string[] = [];
  const fontsUrl = googleFontsLinkUrl(theme);
  if (fontsUrl) {
    parts.push(
      `<link rel="preconnect" href="https://fonts.googleapis.com">`,
      `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
      `<link rel="stylesheet" href="${fontsUrl}">`,
    );
  }
  const themeCss = renderThemeCss(theme);
  if (themeCss) parts.push(`<style data-wanderline-theme>\n${themeCss}\n</style>`);
  return parts.join('\n');
}

// --- Build-time font bundling ----------------------------------------

const WOFF2_USER_AGENT =
  // Telling Google we support woff2 yields the smallest payload.
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.0 Safari/605.1.15';

/**
 * Download every @font-face referenced by a Google Fonts URL into
 * `outputDir`, rewrite the URLs in the CSS to point at the local
 * copies, and return the rewritten CSS. The caller is expected to
 * inject the CSS via a <style> tag (or write it to a sibling file
 * and <link rel="stylesheet"> it).
 *
 * Best-effort: a single failed download logs a warning and skips
 * that face. If the initial CSS fetch fails, returns null and the
 * caller should fall through to the preview <link> behavior.
 */
export async function bundleGoogleFonts(
  theme: ThemeConfig | undefined,
  outputDir: string,
): Promise<string | null> {
  const cssUrl = googleFontsLinkUrl(theme);
  if (!cssUrl) return null;

  let css: string;
  try {
    const res = await fetch(cssUrl, { headers: { 'user-agent': WOFF2_USER_AGENT } });
    if (!res.ok) {
      logger.warn({ statusCode: res.status, cssUrl }, 'Google Fonts CSS fetch returned non-200');
      return null;
    }
    css = await res.text();
  } catch (err) {
    logger.warn({ err, cssUrl }, 'Failed to fetch Google Fonts CSS');
    return null;
  }

  mkdirSync(outputDir, { recursive: true });

  // Find every `url(https://...woff2)` and replace with a local path.
  // Naming: hash the URL so two fonts that happen to share a basename
  // don't collide.
  const urlPattern = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g;
  const urlMap = new Map<string, string>();
  const matches = [...css.matchAll(urlPattern)];
  for (const match of matches) {
    const url = match[1];
    if (urlMap.has(url)) continue;
    const filename = await downloadFontFile(url, outputDir);
    if (filename) urlMap.set(url, filename);
  }
  if (urlMap.size === 0) return null;

  // Rewrite the CSS so each woff2 URL points at fonts/<filename>.
  // Anything we failed to download is left alone (browser will try
  // the original URL — least-surprising fallback for the unlikely
  // partial-failure case).
  return css.replace(urlPattern, (whole, url) => {
    const local = urlMap.get(url);
    return local ? `url(./fonts/${local})` : whole;
  });
}

async function downloadFontFile(url: string, outputDir: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': WOFF2_USER_AGENT } });
    if (!res.ok) {
      logger.warn({ statusCode: res.status, url }, 'Font file fetch returned non-200');
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Stable, collision-resistant filename derived from the URL.
    const hash = await hashString(url);
    const filename = `${hash.slice(0, 12)}.woff2`;
    writeFileSync(join(outputDir, filename), buf);
    return filename;
  } catch (err) {
    logger.warn({ err, url }, 'Failed to download font file');
    return null;
  }
}

async function hashString(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}
