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

import { COMPONENT_SPEC_BY_ID, componentVarName, type ComponentId } from '@wanderline/shared';

const HOVER_OUTLINE = '0 0 0 2px var(--wl-accent, #4ecdc4)';

let installed = false;

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

function applyFonts(theme: { bodyFont?: string; headingFont?: string } | undefined) {
  const root = document.documentElement;
  root.style.removeProperty('--wl-font-body');
  root.style.removeProperty('--wl-font-heading');
  if (!theme) return;
  if (theme.bodyFont) {
    const name = theme.bodyFont.trim();
    if (name) root.style.setProperty('--wl-font-body', /\s/.test(name) ? `'${name}'` : name);
  }
  if (theme.headingFont) {
    const name = theme.headingFont.trim();
    if (name) root.style.setProperty('--wl-font-heading', /\s/.test(name) ? `'${name}'` : name);
  }
}

export function installThemeInspect(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!isInspectModeRequested()) return;
  installed = true;

  document.documentElement.setAttribute('data-theme-inspect', '1');

  // Inject an outline-on-hover stylesheet so authors can see what
  // they're about to click. Keeping this in a <style> tag (rather
  // than per-element inline styles) means it doesn't pollute the
  // build / preview HTML for non-inspect callers.
  const css = document.createElement('style');
  css.textContent = `
    [data-theme-inspect="1"] [data-theme-component]:hover {
      box-shadow: ${HOVER_OUTLINE};
      cursor: pointer !important;
    }
    [data-theme-inspect="1"] [data-theme-component] {
      transition: box-shadow 120ms ease-in-out;
    }
  `;
  document.head.appendChild(css);

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
    applyVariables(theme.variables);
    applyFonts({ bodyFont: theme.bodyFont, headingFont: theme.headingFont });
    applyComponentTheme(theme.components);
  });

  // Tell the parent we're alive so the editor can show "inspector
  // ready" feedback (and so it knows it can start sending updates).
  // Same reasoning as above: scope to our own origin instead of `*`.
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'wanderline:inspect-ready' }, window.location.origin);
  }
}
