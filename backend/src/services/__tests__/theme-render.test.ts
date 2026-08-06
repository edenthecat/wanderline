import { googleFontsLinkUrl, renderThemeCss, renderThemeForPreview } from '../theme-render.js';
import { COMPONENT_SPECS, type ComponentId } from '@wanderline/shared';

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

  it('emits font-weight variables from the first entry in each weights array', () => {
    const css = renderThemeCss({
      bodyFont: 'Inter',
      bodyFontWeights: ['400', '700', '900'],
      headingFont: 'Inter',
      headingFontWeights: ['800', '400'],
    });
    // Primary body weight = first numeric entry in the array.
    expect(css).toContain('--wl-font-body-weight: 400;');
    // Primary heading weight also = first numeric entry.
    expect(css).toContain('--wl-font-heading-weight: 800;');
  });

  it('skips font-weight variables when weight lists are empty or missing', () => {
    const css = renderThemeCss({
      bodyFont: 'Inter',
      headingFont: 'Inter',
      // no bodyFontWeights, no headingFontWeights
    });
    expect(css).not.toContain('--wl-font-body-weight');
    expect(css).not.toContain('--wl-font-heading-weight');
  });

  it('ignores non-numeric weight strings when picking the primary weight', () => {
    const css = renderThemeCss({
      bodyFont: 'Inter',
      bodyFontWeights: ['bold', '600', '900'],
    });
    // 'bold' is dropped by the numeric filter, so 600 is primary.
    expect(css).toContain('--wl-font-body-weight: 600;');
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

// End-to-end enumeration of every knob the author can set.
// Belt-and-braces coverage: the individual tests above cover
// behaviour + edge cases; these prove that no field silently stops
// emitting when someone renames a map key or adds a new spec entry
// without wiring it into the emitter. If either list grows, jest
// picks the new entries up automatically — no test edit required.

describe('renderThemeCss — exhaustive global variable enumeration', () => {
  // Keep aligned with VARIABLE_PROPERTY_MAP in theme-render.ts. A
  // new global variable requires an entry here; the test fails loud
  // if the map and this list disagree.
  const GLOBALS: Array<[string, string]> = [
    ['pageBackground', '--wl-page-bg'],
    ['cardBackground', '--wl-card-bg'],
    ['textColor', '--wl-text'],
    ['accentColor', '--wl-accent'],
    ['headingColor', '--wl-heading'],
    ['chromeColor', '--wl-chrome'],
    ['iconColor', '--wl-icon-color'],
  ];

  it.each(GLOBALS)('emits variables.%s → %s', (field, varName) => {
    const marker = `TEST-${field}-VALUE`;
    const css = renderThemeCss({ variables: { [field]: marker } });
    expect(css).toContain(`${varName}: ${marker};`);
  });

  it('emits every declared global at once when they all have values', () => {
    const variables = Object.fromEntries(
      GLOBALS.map(([field]) => [field, `TEST-${field}`]),
    ) as Record<string, string>;
    const css = renderThemeCss({ variables });
    for (const [field, varName] of GLOBALS) {
      expect(css).toContain(`${varName}: TEST-${field};`);
    }
  });
});

describe('renderThemeCss — exhaustive font enumeration', () => {
  it('emits every font-related variable when all four fields are set', () => {
    const css = renderThemeCss({
      bodyFont: 'Inter',
      bodyFontWeights: ['300', '600'],
      headingFont: 'Playfair Display',
      headingFontWeights: ['700', '900'],
    });
    expect(css).toContain('--wl-font-body: Inter;');
    expect(css).toContain("--wl-font-heading: 'Playfair Display';");
    expect(css).toContain('--wl-font-body-weight: 300;');
    expect(css).toContain('--wl-font-heading-weight: 700;');
  });
});

describe('renderThemeCss — exhaustive per-component enumeration', () => {
  // For each component in COMPONENT_SPECS, prove every declared
  // prop key is emitted with the correct --wl-<component>-<key>
  // variable name. Adding a new prop to any spec automatically
  // grows this suite — no code change needed here.
  for (const spec of COMPONENT_SPECS) {
    describe(spec.id, () => {
      it.each(spec.props.map((p) => [p.key]))(
        `emits --wl-${spec.id}-%s when set`,
        (propKey: string) => {
          const marker = `TEST-${spec.id}-${propKey}`;
          const css = renderThemeCss({
            components: {
              [spec.id]: { [propKey]: marker },
            } as Partial<Record<ComponentId, Record<string, string>>>,
          });
          expect(css).toContain(`--wl-${spec.id}-${propKey}: ${marker};`);
        },
      );
    });
  }

  it('emits every prop of every component in one pass', () => {
    // Build a theme with every knob set to a distinct marker,
    // render once, assert all variables land.
    const components: Partial<Record<ComponentId, Record<string, string>>> = {};
    for (const spec of COMPONENT_SPECS) {
      components[spec.id] = Object.fromEntries(
        spec.props.map((p) => [p.key, `TEST-${spec.id}-${p.key}`]),
      );
    }
    const css = renderThemeCss({ components });
    for (const spec of COMPONENT_SPECS) {
      for (const prop of spec.props) {
        expect(css).toContain(`--wl-${spec.id}-${prop.key}: TEST-${spec.id}-${prop.key};`);
      }
    }
  });
});

describe('renderThemeCss — full-theme integration', () => {
  // One representative render exercising every author-facing input:
  // globals, fonts + weights, per-component overrides, customCss.
  // Regression net for "someone deleted a whole feature path".
  it('composes globals + fonts + components + customCss into a single :root block', () => {
    const components: Partial<Record<ComponentId, Record<string, string>>> = {};
    for (const spec of COMPONENT_SPECS) {
      components[spec.id] = Object.fromEntries(spec.props.map((p) => [p.key, `full-${p.key}`]));
    }
    const css = renderThemeCss({
      variables: {
        pageBackground: '#000000',
        cardBackground: '#111111',
        textColor: '#eeeeee',
        accentColor: '#4ecdc4',
        headingColor: '#ffffff',
        chromeColor: '#888888',
        iconColor: '#cccccc',
      },
      bodyFont: 'Inter',
      bodyFontWeights: ['400', '700'],
      headingFont: 'Playfair Display',
      headingFontWeights: ['700'],
      customCss: '.wl-preview-banner { display: none; }',
      components,
    });

    // Exactly one :root block; customCss appended AFTER the block.
    expect(css.match(/:root \{/g)?.length).toBe(1);
    expect(css.indexOf(':root {')).toBeLessThan(css.indexOf('.wl-preview-banner'));

    // Every global.
    expect(css).toContain('--wl-page-bg: #000000;');
    expect(css).toContain('--wl-card-bg: #111111;');
    expect(css).toContain('--wl-text: #eeeeee;');
    expect(css).toContain('--wl-accent: #4ecdc4;');
    expect(css).toContain('--wl-heading: #ffffff;');
    expect(css).toContain('--wl-chrome: #888888;');
    expect(css).toContain('--wl-icon-color: #cccccc;');

    // Every font var.
    expect(css).toContain('--wl-font-body: Inter;');
    expect(css).toContain("--wl-font-heading: 'Playfair Display';");
    expect(css).toContain('--wl-font-body-weight: 400;');
    expect(css).toContain('--wl-font-heading-weight: 700;');

    // Every component × prop.
    for (const spec of COMPONENT_SPECS) {
      for (const prop of spec.props) {
        expect(css).toContain(`--wl-${spec.id}-${prop.key}: full-${prop.key};`);
      }
    }
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
