import { googleFontsLinkUrl, renderThemeCss, renderThemeForPreview } from '../theme-render.js';

// theme rendering. Pure-string helpers — no network, no
// filesystem. The font-bundling path (bundleGoogleFonts) is covered
// by integration testing against the live build pipeline; mocking
// global fetch in jest is brittle and the helper degrades to null
// on failure anyway.

describe('googleFontsLinkUrl', () => {
  it('returns null when no fonts are set', () => {
    expect(googleFontsLinkUrl(undefined)).toBeNull();
    expect(googleFontsLinkUrl({})).toBeNull();
    expect(googleFontsLinkUrl({ bodyFont: '' })).toBeNull();
  });

  it('builds a single-family URL for body font alone', () => {
    const url = googleFontsLinkUrl({ bodyFont: 'Inter' });
    expect(url).toContain('family=Inter');
    expect(url).toContain('display=swap');
  });

  it('escapes spaces in family names with +', () => {
    const url = googleFontsLinkUrl({ bodyFont: 'Playfair Display' });
    expect(url).toContain('family=Playfair+Display');
  });

  it('encodes weights via :wght@', () => {
    const url = googleFontsLinkUrl({
      bodyFont: 'Inter',
      bodyFontWeights: ['400', '700'],
    });
    expect(url).toContain('Inter:wght@400;700');
  });

  it('drops invalid weight strings', () => {
    const url = googleFontsLinkUrl({
      bodyFont: 'Inter',
      // Only digit-only entries should land in the URL.
      bodyFontWeights: ['400', 'abc', '700'],
    });
    expect(url).toContain('Inter:wght@400;700');
    expect(url).not.toContain('abc');
  });

  it('adds the heading family when it differs from the body', () => {
    const url = googleFontsLinkUrl({
      bodyFont: 'Inter',
      headingFont: 'Playfair Display',
    });
    expect(url).toContain('family=Inter');
    expect(url).toContain('family=Playfair+Display');
  });

  it('skips the heading family when identical to the body', () => {
    const url = googleFontsLinkUrl({ bodyFont: 'Inter', headingFont: 'Inter' });
    // Only one family= segment.
    expect(url?.match(/family=/g)?.length).toBe(1);
  });

  it('strips path-meta characters from family names', () => {
    const url = googleFontsLinkUrl({ bodyFont: '../../etc/passwd' });
    // The base URL legitimately contains '/'; assert the family
    // segment has had the path-meta chars scrubbed.
    const familyMatch = /family=([^&]*)/.exec(url ?? '');
    expect(familyMatch?.[1] ?? '').not.toContain('/');
    expect(familyMatch?.[1] ?? '').not.toContain('..');
  });
});

describe('renderThemeCss', () => {
  it('returns an empty string for an empty theme', () => {
    expect(renderThemeCss(undefined)).toBe('');
    expect(renderThemeCss({})).toBe('');
  });

  it('emits :root variables for each set knob', () => {
    const css = renderThemeCss({
      variables: {
        pageBackground: '#000',
        accentColor: '#ff0',
      },
    });
    expect(css).toMatch(/:root \{/);
    expect(css).toContain('--wl-page-bg: #000;');
    expect(css).toContain('--wl-accent: #ff0;');
    // Unset knobs don't appear at all.
    expect(css).not.toContain('--wl-text');
  });

  it('emits font-family variables when fonts are set', () => {
    const css = renderThemeCss({ bodyFont: 'Inter', headingFont: 'Playfair Display' });
    expect(css).toContain('--wl-font-body: Inter;');
    // Names with spaces get quoted.
    expect(css).toContain("--wl-font-heading: 'Playfair Display';");
  });

  it('appends customCss after the :root block', () => {
    const css = renderThemeCss({
      variables: { pageBackground: '#000' },
      customCss: '.choice-button { letter-spacing: 0.02em; }',
    });
    expect(css.indexOf(':root')).toBeLessThan(css.indexOf('.choice-button'));
    expect(css).toContain('letter-spacing');
  });

  it('strips embedded </style> from customCss', () => {
    const css = renderThemeCss({
      customCss: 'body { color: red; }</style><script>alert(1)</script>',
    });
    expect(css).not.toMatch(/<\/style>/i);
    // Tag-stripping is strict on the closing tag only; script tags
    // *inside* customCss aren't our concern — the browser won't
    // execute them inside a <style> block.
    expect(css).toContain('body { color: red; }');
  });

  // Regression: HTML5 tokenizes an end tag as `</` + tagname + any
  // whitespace + optional attributes + `>`. The original strip only
  // matched the exact literal `</style>`, so each of the variants
  // below closed the injected <style> block and let the following
  // <script> run in downloaded builds (which ship without CSP).
  describe('customCss </style> stripping — end-tag grammar variants', () => {
    it.each([
      ['trailing space', 'body{}</style ><script>alert(1)</script>'],
      ['multiple spaces + tab', 'body{}</style \t ><script>alert(1)</script>'],
      ['embedded newline', 'body{}</style\n><script>alert(1)</script>'],
      ['carriage return', 'body{}</style\r><script>alert(1)</script>'],
      ['form feed', 'body{}</style\f><script>alert(1)</script>'],
      ['attribute-like garbage', 'body{}</style foo="bar"><script>alert(1)</script>'],
      ['slash before >', 'body{}</style/><script>alert(1)</script>'],
      ['mixed case', 'body{}</StYlE><script>alert(1)</script>'],
      ['uppercase', 'body{}</STYLE ><script>alert(1)</script>'],
    ])('closes the <style> block via %s', (_desc, malicious) => {
      const css = renderThemeCss({ customCss: malicious });
      // Nothing that looks like an end-tag for <style> survives.
      expect(css).not.toMatch(/<\/style[\s/>]/i);
      // Defence-in-depth: the follow-up <script> stays as inert
      // text (not our regex's job to strip, but confirming it
      // wasn't spliced OUT of the block).
      expect(css).toContain('<script>alert(1)</script>');
    });

    it('does NOT strip </styleblah> — that is not a style end tag in HTML5', () => {
      // </styleblah> is treated as raw text inside <style>, not an
      // end tag. Stripping it would corrupt legitimate content.
      const css = renderThemeCss({
        customCss: '.a::before { content: "</styleblah>"; }',
      });
      expect(css).toContain('</styleblah>');
    });
  });

  it('strips control characters and angle brackets from variable values', () => {
    const css = renderThemeCss({
      variables: {
        //  (BEL) — should be removed.
        accentColor: '#fff<script>',
      },
    });
    expect(css).not.toContain('');
    expect(css).not.toContain('<');
    expect(css).toContain('--wl-accent: #fff');
  });
});

describe('renderThemeCss — per-component overrides', () => {
  it('emits no component vars when components is empty', () => {
    const css = renderThemeCss({ components: {} });
    expect(css).toBe('');
  });

  it('emits component-scoped variables per overridden property', () => {
    const css = renderThemeCss({
      components: { choiceButton: { background: '#ff0', textColor: '#fff' } },
    });
    expect(css).toContain('--wl-choiceButton-background: #ff0;');
    expect(css).toContain('--wl-choiceButton-textColor: #fff;');
    expect(css).not.toContain('--wl-choiceButton-hoverBackground');
  });

  it('combines global variables with per-component overrides under one :root', () => {
    const css = renderThemeCss({
      variables: { accentColor: '#0f0' },
      components: { storyCard: { borderRadius: '20px' } },
    });
    expect(css.match(/:root \{/g)?.length).toBe(1);
    expect(css).toContain('--wl-accent: #0f0;');
    expect(css).toContain('--wl-storyCard-borderRadius: 20px;');
  });

  it('strips control characters and angle brackets from component values', () => {
    // Build a value with an explicit BEL char so the test source
    // doesn't carry an invisible byte (and so `toContain` actually
    // tests what we mean).
    const bel = String.fromCharCode(0x07);
    const css = renderThemeCss({
      components: { choiceButton: { background: `#fff${bel}<script>` } },
    });
    expect(css).not.toContain(bel);
    expect(css).not.toContain('<');
    expect(css).toContain('--wl-choiceButton-background: #fffscript');
  });

  it('ignores whitespace-only overrides', () => {
    const css = renderThemeCss({
      components: { choiceButton: { background: '   ', textColor: '#fff' } },
    });
    expect(css).not.toContain('--wl-choiceButton-background');
    expect(css).toContain('--wl-choiceButton-textColor: #fff;');
  });

  it('skips properties that are not in the component spec', () => {
    const css = renderThemeCss({
      components: { choiceButton: { unknownProp: 'red', background: '#000' } },
    });
    expect(css).not.toContain('unknownProp');
    expect(css).toContain('--wl-choiceButton-background: #000;');
  });

  it('skips unknown component ids', () => {
    // Bypass the typed components map so we can plant a junk key.
    const css = renderThemeCss({
      components: {
        choiceButton: { background: '#000' },
        ...({ ghostComponent: { background: '#fff' } } as unknown as Record<string, never>),
      },
    });
    expect(css).toContain('--wl-choiceButton-background: #000;');
    expect(css).not.toContain('ghostComponent');
  });
});

describe('renderThemeForPreview', () => {
  it('returns empty when no theme is set', () => {
    expect(renderThemeForPreview(undefined)).toBe('');
    expect(renderThemeForPreview({})).toBe('');
  });

  it('emits a Google Fonts link + theme style block', () => {
    const fragment = renderThemeForPreview({
      bodyFont: 'Inter',
      variables: { accentColor: '#0f0' },
    });
    expect(fragment).toContain('https://fonts.googleapis.com/css2?family=Inter');
    expect(fragment).toContain('<style data-wanderline-theme>');
    expect(fragment).toContain('--wl-accent: #0f0;');
  });

  it('omits the link when no fonts are configured', () => {
    const fragment = renderThemeForPreview({ variables: { textColor: '#fff' } });
    expect(fragment).not.toContain('fonts.googleapis.com');
    expect(fragment).toContain('--wl-text: #fff;');
  });
});
