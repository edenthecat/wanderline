// inspector + live-preview wiring for the player when it
// runs inside the editor's ThemeTab iframe. The editor passes
// `?inspect=1` in the iframe URL; we add a click handler on every
// `[data-theme-component]` element that posts the component id to
// `window.parent`, and we listen for live `wanderline:theme-update`
// messages so dragging a color picker updates the player without a
// save round-trip.
//
// Module-level guard so multiple calls (HMR in dev) don't stack
// listeners.

import {
  COMPONENT_SPEC_BY_ID,
  componentVarName,
  fontFamilyValue,
  googleFontsLinkUrl,
  primaryFontWeight,
  type ComponentId,
  type ThemeFontConfig,
} from '@wanderline/shared';

const HOVER_OUTLINE = '0 0 0 2px var(--wl-accent, #4ecdc4)';

let installed = false;

/**
 * A stylesheet we can rewrite on every theme edit.
 *
 * CSP note: the preview is served under `style-src 'self' 'nonce-<n>'`
 * with no `'unsafe-inline'` (see buildPreviewCsp in
 * backend/src/routes/projects-preview.ts). A <style> element created by
 * script does NOT inherit the document's nonce, so appending one is
 * blocked outright. Constructed stylesheets go through CSSOM rather
 * than the inline-style path and CSP does not gate them, so that is the
 * primary route here. The <style> fallback exists only for engines
 * without constructable stylesheets (and for jsdom under test), where
 * it is no worse than what we did before.
 */
interface ManagedSheet {
  apply(css: string): void;
}

function createManagedSheet(marker: string): ManagedSheet {
  let constructed: CSSStyleSheet | null = null;
  let fallbackEl: HTMLStyleElement | null = null;

  try {
    const sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    constructed = sheet;
  } catch {
    constructed = null;
  }

  return {
    apply(css: string) {
      // Guarded because this runs inside the message handler, which
      // applies six things in sequence: one throw here would silently
      // stop the rest of the theme from being applied and the author
      // would be back to "my change did nothing".
      //
      // CSS parsing is error-tolerant, so half-typed customCss does not
      // actually throw: unclosed braces, garbage and partial properties
      // all parse to zero or more valid rules, and an @import is dropped
      // per spec rather than raising. replaceSync throws only for a
      // non-constructed sheet. The catch is cheap insurance, not a
      // workaround for a reproducible failure.
      try {
        if (constructed) {
          constructed.replaceSync(css);
          return;
        }
      } catch {
        // Fall through to the <style> element below.
        constructed = null;
      }
      if (!fallbackEl) {
        fallbackEl = document.createElement('style');
        fallbackEl.setAttribute(marker, '');
        document.head.appendChild(fallbackEl);
      }
      fallbackEl.textContent = css;
    },
  };
}

// Lazily created so nothing touches CSSOM until inspect mode installs.
let customCssSheet: ManagedSheet | null = null;

/**
 * Apply the author's raw customCss for unsaved edits.
 *
 * A full server render appends customCss last (renderThemeCss), after
 * the variable block, so author rules can override the generated
 * variables. We keep that ordering by calling this last in the message
 * handler and by writing to a sheet that is adopted after the
 * document's own <style>.
 */
function applyCustomCss(css: string | undefined): void {
  if (!customCssSheet) customCssSheet = createManagedSheet('data-wanderline-live-css');
  customCssSheet.apply(typeof css === 'string' ? css : '');
}

/**
 * Mirror the backend's `--wl-font-*-weight` emission for unsaved edits.
 *
 * Uses the shared primaryFontWeight so the live preview and a saved
 * render can't disagree about which entry in the array wins.
 */
function applyFontWeights(theme: ThemeFontConfig | undefined): void {
  const root = document.documentElement;
  root.style.removeProperty('--wl-font-body-weight');
  root.style.removeProperty('--wl-font-heading-weight');
  if (!theme) return;
  const body = primaryFontWeight(theme.bodyFontWeights);
  if (body) root.style.setProperty('--wl-font-body-weight', body);
  const heading = primaryFontWeight(theme.headingFontWeights);
  if (heading) root.style.setProperty('--wl-font-heading-weight', heading);
}

// The <link> carrying the Google Fonts stylesheet for live edits.
let fontLinkEl: HTMLLinkElement | null = null;

/**
 * Load the font families the author just picked.
 *
 * Setting --wl-font-body alone is not enough: if the family has never
 * been fetched, the browser has no face to render and silently falls
 * back, which reads to the author as "picking a font did nothing".
 * A full render emits this <link> server-side; for unsaved edits we
 * maintain the equivalent one ourselves. An external stylesheet is
 * governed by the style-src host allowlist (which already includes
 * fonts.googleapis.com) rather than by the nonce, so no nonce needed.
 */
function applyGoogleFonts(theme: ThemeFontConfig | undefined): void {
  const url = googleFontsLinkUrl(theme);
  if (!url) {
    fontLinkEl?.remove();
    fontLinkEl = null;
    return;
  }
  if (!fontLinkEl) {
    fontLinkEl = document.createElement('link');
    fontLinkEl.rel = 'stylesheet';
    fontLinkEl.setAttribute('data-wanderline-live-fonts', '');
    document.head.appendChild(fontLinkEl);
  }
  if (fontLinkEl.getAttribute('href') !== url) fontLinkEl.setAttribute('href', url);
}

function isInspectModeRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('inspect') === '1';
  } catch {
    return false;
  }
}

function findComponentTarget(el: Element | null): HTMLElement | null {
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    if (cur instanceof HTMLElement && cur.dataset.themeComponent) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function emitInspect(componentId: string) {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'wanderline:inspect', componentId }, '*');
  }
}

// Apply a theme.components map onto :root as CSS variables. Used by
// the live-preview listener so the iframe reflects unsaved edits.
function applyComponentTheme(components: Record<string, Record<string, unknown>> | undefined) {
  const root = document.documentElement;
  // Wipe ONLY the per-component vars we manage so a deleted override
  // disappears immediately. Globals stay (handled by --wl-* in the
  // injected <style data-wanderline-theme> block).
  for (const id of Object.keys(COMPONENT_SPEC_BY_ID) as ComponentId[]) {
    const spec = COMPONENT_SPEC_BY_ID[id];
    for (const prop of spec.props) {
      root.style.removeProperty(componentVarName(id, prop.key));
    }
  }
  if (!components) return;
  for (const [id, props] of Object.entries(components)) {
    if (!props || typeof props !== 'object') continue;
    const spec = COMPONENT_SPEC_BY_ID[id as ComponentId];
    if (!spec) continue;
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'string' && value.trim()) {
        root.style.setProperty(componentVarName(id as ComponentId, key), value.trim());
      }
    }
  }
}

function applyVariables(vars: Record<string, unknown> | undefined) {
  const root = document.documentElement;
  const MAP: Record<string, string> = {
    pageBackground: '--wl-page-bg',
    cardBackground: '--wl-card-bg',
    textColor: '--wl-text',
    accentColor: '--wl-accent',
    headingColor: '--wl-heading',
    chromeColor: '--wl-chrome',
    iconColor: '--wl-icon-color',
  };
  for (const prop of Object.values(MAP)) root.style.removeProperty(prop);
  if (!vars) return;
  for (const [key, value] of Object.entries(vars)) {
    const cssName = MAP[key];
    if (cssName && typeof value === 'string' && value.trim()) {
      root.style.setProperty(cssName, value.trim());
    }
  }
}

/**
 * Set the family variables for unsaved edits.
 *
 * Uses the shared fontFamilyValue rather than a local trim-and-quote so
 * the live preview agrees with a saved render character for character.
 * FontPicker accepts free-typed input, and the local version quoted the
 * raw string without the escaping the backend applies, so a family
 * containing quotes or a semicolon rendered differently live than after
 * save (and could terminate the declaration). Two implementations of the
 * same rule drifting apart is the whole reason these helpers moved into
 * @wanderline/shared.
 */
function applyFonts(theme: ThemeFontConfig | undefined) {
  const root = document.documentElement;
  root.style.removeProperty('--wl-font-body');
  root.style.removeProperty('--wl-font-heading');
  if (!theme) return;
  if (theme.bodyFont) {
    const value = fontFamilyValue(theme.bodyFont);
    if (value) root.style.setProperty('--wl-font-body', value);
  }
  if (theme.headingFont) {
    const value = fontFamilyValue(theme.headingFont);
    if (value) root.style.setProperty('--wl-font-heading', value);
  }
}

export function installThemeInspect(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!isInspectModeRequested()) return;
  installed = true;

  document.documentElement.setAttribute('data-theme-inspect', '1');

  // Outline-on-hover so authors can see what they're about to click.
  // Kept out of the preview/build HTML for non-inspect callers.
  //
  // This used to append a bare <style> element, which the preview's
  // nonce-based style-src blocks (a script-created <style> does not
  // inherit the document nonce), so the hover affordance never
  // actually rendered inside the editor. Routed through the same
  // constructed-stylesheet helper as live customCss, which CSP does
  // not gate.
  createManagedSheet('data-wanderline-inspect-css').apply(`
    [data-theme-inspect="1"] [data-theme-component]:hover {
      box-shadow: ${HOVER_OUTLINE};
      cursor: pointer !important;
    }
    [data-theme-inspect="1"] [data-theme-component] {
      transition: box-shadow 120ms ease-in-out;
    }
  `);

  // Capture clicks. We use the capture phase + stopPropagation so the
  // player's own click handlers (start story, navigate, etc.) don't
  // fire while the inspector is "on".
  document.addEventListener(
    'click',
    (event) => {
      const target = findComponentTarget(event.target as Element | null);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      emitInspect(target.dataset.themeComponent ?? '');
    },
    true,
  );

  // Live theme updates from the parent editor. We only accept
  // messages from `window.parent` (the editor iframe host) and only
  // when our own origin matches the event origin — both windows are
  // same-origin in the editor scenario. This prevents a stray same-
  // origin tab from spoofing inspector updates, and prevents a
  // cross-origin embedder from injecting CSS variables.
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (event.origin !== window.location.origin) return;
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type !== 'wanderline:theme-update') return;
    const theme = event.data.theme ?? {};
    const fontConfig: ThemeFontConfig = {
      bodyFont: theme.bodyFont,
      bodyFontWeights: theme.bodyFontWeights,
      headingFont: theme.headingFont,
      headingFontWeights: theme.headingFontWeights,
    };
    applyVariables(theme.variables);
    applyFonts({ bodyFont: theme.bodyFont, headingFont: theme.headingFont });
    applyFontWeights(fontConfig);
    // Fetch the families before the component pass so the faces are in
    // flight while the rest of the variables settle.
    applyGoogleFonts(fontConfig);
    applyComponentTheme(theme.components);
    // Last, so author rules win over everything generated above —
    // same precedence a full server render produces.
    applyCustomCss(theme.customCss);
  });

  // Tell the parent we're alive so the editor can show "inspector
  // ready" feedback (and so it knows it can start sending updates).
  // Same reasoning as above: scope to our own origin instead of `*`.
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'wanderline:inspect-ready' }, window.location.origin);
  }
}
