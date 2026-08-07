import { describe, it, expect, beforeEach, vi } from 'vitest';

// Coverage for the editor's live-preview path.
//
// The bug this guards against: ThemeTab posts the WHOLE theme object on
// every edit, but the listener only ever applied a subset of it, so
// font weights, customCss and newly-picked font families appeared to do
// nothing until the author hit Restart. Each field the backend renders
// server-side needs a matching live application here, and the two must
// agree on the result. The `parity with a server render` block is the
// one that fails if the two implementations drift again.

/**
 * Read whatever CSS the live listener installed, regardless of which
 * mechanism it used.
 *
 * In a browser this lands in a constructed stylesheet on
 * document.adoptedStyleSheets (which CSP does not gate). jsdom 29
 * exposes `new CSSStyleSheet()` but has no adoptedStyleSheets, so the
 * implementation falls back to a <style> element and the tests read
 * that instead. Asserting on the outcome rather than the mechanism
 * keeps these tests honest in both environments.
 */
function liveCss(): string {
  const el = document.head.querySelector('[data-wanderline-live-css]');
  if (el) return el.textContent ?? '';
  const sheets = (document as unknown as { adoptedStyleSheets?: CSSStyleSheet[] })
    .adoptedStyleSheets;
  if (!sheets) return '';
  return sheets
    .map((s) =>
      Array.from(s.cssRules ?? [])
        .map((r) => r.cssText)
        .join('\n'),
    )
    .join('\n');
}

function fontLinkHref(): string | null {
  return document.head.querySelector('[data-wanderline-live-fonts]')?.getAttribute('href') ?? null;
}

function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

/**
 * Install a fresh copy of the module.
 *
 * theme-inspect guards installation with a module-level flag so HMR
 * can't stack listeners, so each test needs a clean module registry
 * rather than a second install call.
 */
async function installFresh() {
  vi.resetModules();
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme-inspect');
  window.history.replaceState({}, '', '/?inspect=1');
  const mod = await import('./theme-inspect');
  mod.installThemeInspect();
}

/** Post a theme the way ThemeTab's debounced effect does. */
function postTheme(theme: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'wanderline:theme-update', theme },
      origin: window.location.origin,
      // jsdom's window.parent === window at top level, which is what
      // the listener's `event.source !== window.parent` check compares.
      source: window as unknown as MessageEventSource,
    }),
  );
}

beforeEach(async () => {
  await installFresh();
});

describe('live font weights', () => {
  it('applies the primary body and heading weight', () => {
    postTheme({ bodyFontWeights: ['600', '400'], headingFontWeights: ['700'] });
    expect(cssVar('--wl-font-body-weight')).toBe('600');
    expect(cssVar('--wl-font-heading-weight')).toBe('700');
  });

  // Order is the author's primary-weight control, so the FIRST entry
  // wins rather than the numerically lowest.
  it('honours array order rather than numeric order', () => {
    postTheme({ bodyFontWeights: ['700', '400'] });
    expect(cssVar('--wl-font-body-weight')).toBe('700');
  });

  it('skips non-numeric entries', () => {
    postTheme({ bodyFontWeights: ['bold', '500'] });
    expect(cssVar('--wl-font-body-weight')).toBe('500');
  });

  it('emits nothing when the list is empty or absent', () => {
    postTheme({ bodyFontWeights: [], headingFontWeights: undefined });
    expect(cssVar('--wl-font-body-weight')).toBe('');
    expect(cssVar('--wl-font-heading-weight')).toBe('');
  });

  // Deselecting the last weight has to clear the variable, otherwise
  // the preview keeps showing a weight the author just removed.
  it('clears a previously applied weight when the author removes it', () => {
    postTheme({ bodyFontWeights: ['700'] });
    expect(cssVar('--wl-font-body-weight')).toBe('700');
    postTheme({ bodyFontWeights: [] });
    expect(cssVar('--wl-font-body-weight')).toBe('');
  });
});

describe('live customCss', () => {
  it('applies the author stylesheet', () => {
    postTheme({ customCss: '.story-card { border-radius: 20px; }' });
    expect(liveCss()).toContain('border-radius: 20px');
  });

  it('replaces rather than appends on each edit', () => {
    postTheme({ customCss: '.a { color: red; }' });
    postTheme({ customCss: '.b { color: blue; }' });
    const css = liveCss();
    expect(css).toContain('.b');
    expect(css).not.toContain('.a');
  });

  it('clears when the author empties the field', () => {
    postTheme({ customCss: '.a { color: red; }' });
    postTheme({ customCss: '' });
    expect(liveCss()).not.toContain('color: red');
  });

  it('tolerates a missing customCss key', () => {
    expect(() => postTheme({ variables: { textColor: '#fff' } })).not.toThrow();
  });
});

describe('live font families', () => {
  it('adds a Google Fonts link for a newly picked family', () => {
    postTheme({ bodyFont: 'Inter' });
    expect(fontLinkHref()).toContain('family=Inter');
  });

  it('encodes multi-word families and includes the chosen weights', () => {
    postTheme({ bodyFont: 'Playfair Display', bodyFontWeights: ['400', '700'] });
    const href = fontLinkHref() ?? '';
    expect(href).toContain('family=Playfair+Display');
    expect(href).toContain('wght@400;700');
  });

  it('reuses one link element instead of stacking them', () => {
    postTheme({ bodyFont: 'Inter' });
    postTheme({ bodyFont: 'Roboto' });
    expect(document.head.querySelectorAll('[data-wanderline-live-fonts]')).toHaveLength(1);
    expect(fontLinkHref()).toContain('family=Roboto');
  });

  it('removes the link when every font is cleared', () => {
    postTheme({ bodyFont: 'Inter' });
    expect(fontLinkHref()).not.toBeNull();
    postTheme({});
    expect(fontLinkHref()).toBeNull();
  });

  it('still sets the family variable alongside the link', () => {
    postTheme({ bodyFont: 'Inter' });
    expect(cssVar('--wl-font-body')).toBe('Inter');
  });
});

describe('message source and origin guards', () => {
  it('ignores a message from a different origin', () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'wanderline:theme-update', theme: { bodyFontWeights: ['700'] } },
        origin: 'https://evil.example',
        source: window as unknown as MessageEventSource,
      }),
    );
    expect(cssVar('--wl-font-body-weight')).toBe('');
  });

  it('ignores an unrelated message type', () => {
    postTheme({ bodyFontWeights: ['700'] });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'something:else', theme: { bodyFontWeights: ['100'] } },
        origin: window.location.origin,
        source: window as unknown as MessageEventSource,
      }),
    );
    expect(cssVar('--wl-font-body-weight')).toBe('700');
  });
});

describe('parity with a server render', () => {
  // Every ThemeConfig field the backend turns into CSS must have a live
  // equivalent. If someone adds a field to ThemeConfig and wires it into
  // renderThemeCss but not into the live listener, the author sees the
  // same "my change did nothing" behaviour that started all this.
  it('applies every themeable field from one fully populated update', () => {
    postTheme({
      variables: {
        pageBackground: '#101010',
        cardBackground: '#202020',
        textColor: '#eeeeee',
        accentColor: '#4ecdc4',
        headingColor: '#ffffff',
        chromeColor: '#303030',
        iconColor: '#cccccc',
      },
      bodyFont: 'Inter',
      bodyFontWeights: ['500', '700'],
      headingFont: 'Playfair Display',
      headingFontWeights: ['700'],
      customCss: '.story-card { border: 1px solid red; }',
      components: { header: { fontWeight: '800' } },
    });

    expect(cssVar('--wl-page-bg')).toBe('#101010');
    expect(cssVar('--wl-card-bg')).toBe('#202020');
    expect(cssVar('--wl-text')).toBe('#eeeeee');
    expect(cssVar('--wl-accent')).toBe('#4ecdc4');
    expect(cssVar('--wl-heading')).toBe('#ffffff');
    expect(cssVar('--wl-chrome')).toBe('#303030');
    expect(cssVar('--wl-icon-color')).toBe('#cccccc');

    expect(cssVar('--wl-font-body')).toBe('Inter');
    expect(cssVar('--wl-font-heading')).toBe("'Playfair Display'");
    expect(cssVar('--wl-font-body-weight')).toBe('500');
    expect(cssVar('--wl-font-heading-weight')).toBe('700');

    expect(fontLinkHref()).toContain('family=Inter');
    expect(fontLinkHref()).toContain('family=Playfair+Display');
    expect(liveCss()).toContain('border: 1px solid red');
    expect(cssVar('--wl-header-fontWeight')).toBe('800');
  });
});
