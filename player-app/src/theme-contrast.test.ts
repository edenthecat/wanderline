import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AA_NORMAL_TEXT,
  composite as compositeRgb,
  contrastRatio,
  evaluateThemeContrast,
  failingThemeContrast,
  unevaluatedThemeContrast,
  parseColor,
  type Rgb,
} from '@wanderline/shared';
import { styles } from './styles';
import { CHARACTER_THEMES, characterThemeCardStyle } from './character-theme';

// Guards for theming and accessibility defects that only appear once a
// theme is applied — which is why the ordinary suite never saw them:
//
//   1. Selecting a choice rendered body text on a SOLID accent fill.
//      The selected state was meant to be a faint wash of the accent
//      with the accent on the border, but the fallback chain reached
//      for `--wl-accent` directly, so setting any accent colour turned
//      the wash into a fill while the label stayed light.
//
//   2. The page background gradient tiled once per viewport, leaving a
//      visible seam partway down any passage longer than the screen.
//
//   3. Character-themed passages hardcoded pastel text for the dark
//      default page, so a light theme rendered them at 1.05–1.23:1.
//
//   4. The footer documenting the keyboard and headphone controls, the
//      offline banner, and the password field's missing focus ring.
//
//   5. Nothing anywhere checked an *author's* colours.
//
// The maths comes from @wanderline/shared rather than a local copy:
// these assertions have to be the same arithmetic the editor warns
// with and the build's smoke page reports, or one of the three will
// quietly disagree with the other two.

const here = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(here, 'index.css'), 'utf8');

function contrast(fg: number[], bg: number[]): number {
  return contrastRatio(fg as Rgb, bg as Rgb);
}

/** Composite a colour at `alpha` over an opaque backdrop. */
function composite(top: number[], bottom: number[], alpha: number): number[] {
  return compositeRgb(top as Rgb, bottom as Rgb, alpha);
}

function hex(h: string): number[] {
  const parsed = parseColor(h);
  if (!parsed) throw new Error(`unparseable colour in test: ${h}`);
  return parsed.rgb;
}

/**
 * Pull one declaration out of a CSS rule block, by selector. Comments
 * are stripped first: several of the rules below carry a note
 * explaining the ratio, and a comment sitting between the previous
 * semicolon and the declaration would otherwise hide it.
 */
function declaration(css: string, selector: string, property: string): string | null {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(stripped);
  if (!rule) return null;
  const decl = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(rule[1]);
  return decl ? decl[1].trim() : null;
}

// The shipped defaults these rules resolve against.
const ACCENT = hex('#4ecdc4'); // --wl-accent
const PAGE_BG = hex('#1a1a2e'); // first stop of the --wl-page-bg gradient
const BODY_TEXT = hex('#eeeeee'); // --wl-text
const AA_NORMAL = AA_NORMAL_TEXT;

describe('selected-choice background', () => {
  it('is a translucent wash rather than an opaque accent fill', () => {
    const bg = styles.choiceSelected.background as string;
    expect(bg).toContain('color-mix');
    expect(bg).toContain('transparent');
  });

  // The precise regression: `var(--wl-accent, <tint>)` means the tint is
  // used ONLY when no accent is set, so every themed project got the
  // opaque fill instead. The accent may still drive the border.
  it('never falls back to a bare accent variable as the fill', () => {
    const bg = styles.choiceSelected.background as string;
    expect(bg).not.toMatch(/var\(\s*--wl-choiceButton-hoverBackground\s*,\s*var\(\s*--wl-accent/);
  });

  it('keeps the accent on the border, which is where it belongs', () => {
    expect(styles.choiceSelected.borderColor).toContain('--wl-accent');
  });

  it('still lets an author override the background outright', () => {
    expect(styles.choiceSelected.background).toContain('--wl-choiceButton-hoverBackground');
  });
});

describe('selected-choice contrast maths', () => {
  // Documents why the fix exists: the old behaviour on the default
  // accent, which is what an author reported as failing.
  it('an opaque accent fill fails AA against body text', () => {
    expect(contrast(BODY_TEXT, ACCENT)).toBeLessThan(AA_NORMAL);
  });

  it('a 20% wash over the page background passes AA against body text', () => {
    const wash = composite(ACCENT, PAGE_BG, 0.2);
    expect(contrast(BODY_TEXT, wash)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  // The wash has to stay light enough to keep passing. If someone
  // raises the mix percentage this is what tells them how far they can
  // go before the label stops being readable.
  it('stays above AA up to a 40% wash and warns beyond', () => {
    expect(contrast(BODY_TEXT, composite(ACCENT, PAGE_BG, 0.4))).toBeGreaterThanOrEqual(AA_NORMAL);
    // Sanity: a near-solid wash is the failing case again.
    expect(contrast(BODY_TEXT, composite(ACCENT, PAGE_BG, 0.95))).toBeLessThan(AA_NORMAL);
  });

  // The start button escaped the bug only by hardcoding dark text. Worth
  // pinning so nobody "tidies" it into inheriting body text.
  it('the start button keeps dark text on its accent fill', () => {
    const color = styles.startBtn.color as string;
    expect(color).toContain('#1a1a2e');
    expect(contrast(hex('#1a1a2e'), ACCENT)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('page background does not tile', () => {
  // `height: 100%` pins html/body to one viewport, which is the
  // gradient's positioning area. With background-repeat defaulting to
  // repeat, anything taller than the screen showed the gradient restart.
  it('sizes html and body with min-height so the gradient spans the document', () => {
    const rule = indexCss.match(/html,\s*body\s*\{[\s\S]*?\}/);
    expect(rule).not.toBeNull();
    const body = rule![0];
    expect(body).toMatch(/min-height:\s*100%/);
    expect(body).not.toMatch(/^\s*height:\s*100%/m);
  });

  // Any percentage height on #root now resolves against an auto-height
  // parent and computes to 0, so declaring one is decoration that reads
  // as though it were load-bearing. Covers min-height too, not just
  // height, since both resolve the same way.
  it('declares no percentage height on #root at all', () => {
    const rule = indexCss.match(/#root\s*\{[\s\S]*?\}/);
    expect(rule).not.toBeNull();
    const declarations = rule![0].replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/(^|[\s;])(min-)?height:\s*\d+%/);
  });

  // The viewport fill the layout actually depends on lives here, so if
  // this ever goes away the min-height change above needs revisiting.
  it('still fills the viewport via the app container', () => {
    expect(styles.container.minHeight).toBe('100vh');
  });
});

// The two palettes every rule below has to survive. The player ships
// the dark one; the Theme tab offers the light one as an ordinary
// choice, and it is the one every hardcoded pastel failed on.
const PALETTES = [
  {
    name: 'default dark theme',
    page: hex('#1a1a2e'),
    card: { rgb: hex('#ffffff'), alpha: 0.1 },
    text: hex('#eeeeee'),
  },
  {
    name: 'light author theme',
    page: hex('#ffffff'),
    card: { rgb: hex('#ffffff'), alpha: 1 },
    text: hex('#111827'),
  },
];

describe('character-themed passages', () => {
  // The regression, stated as a rule rather than as a list of colours:
  // whatever a character theme contributes, the caption has to stay
  // readable on any page the author can pick. The old table set
  // `text: '#fecaca'` and friends inline, which measured ~10:1 on the
  // dark default and 1.05–1.23:1 on white.
  for (const palette of PALETTES) {
    it(`keeps every character caption above AA on the ${palette.name}`, () => {
      for (const [name, theme] of Object.entries(CHARACTER_THEMES)) {
        const tint = parseColor(theme.tint);
        expect(tint, `${name} tint should parse`).not.toBeNull();

        // page -> card -> character tint, which is how the fixed card
        // actually stacks: the tint layers over --wl-card-bg rather
        // than replacing it.
        const cardSurface = composite(palette.card.rgb, palette.page, palette.card.alpha);
        const surface = composite(tint!.rgb, cardSurface, tint!.alpha);

        // If a character ever sets `color` again, that colour is what
        // the listener sees — so that is what gets measured.
        const applied = characterThemeCardStyle(name);
        const inkValue = (applied.color as string | undefined) ?? null;
        const ink = inkValue ? hex(inkValue) : palette.text;

        const ratio = contrast(ink, surface);
        expect(ratio, `${name} on the ${palette.name}`).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });
  }

  it('lets the character own the surface and the border, never the ink', () => {
    const applied = characterThemeCardStyle('red');
    expect(applied.color).toBeUndefined();
    expect(applied.borderLeft).toContain('#ef4444');
  });

  it('layers the tint over the author card background instead of discarding it', () => {
    // The old code assigned `background: <tint>` outright, so an
    // author who themed their card never saw it on a themed passage.
    const applied = characterThemeCardStyle('blue');
    expect(applied.background).toContain('--wl-card-bg');
    expect(applied.background).toContain('rgba(59,130,246,0.15)');
  });

  it('returns nothing for a passage with no character theme', () => {
    expect(characterThemeCardStyle(undefined)).toEqual({});
    expect(characterThemeCardStyle('chartreuse')).toEqual({});
  });
});

describe('player chrome contrast', () => {
  // This footer is the only documentation of the keyboard and
  // headphone controls in the whole player, so it is exactly the text
  // a low-vision keyboard user needs. At opacity 0.4 it measured
  // 3.43:1 against the page.
  it('keeps the controls footer above AA', () => {
    const opacity = styles.footer.opacity;
    expect(typeof opacity).toBe('number');
    const composited = composite(BODY_TEXT, PAGE_BG, opacity as number);
    expect(contrast(composited, PAGE_BG)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  // Shown exactly when a listener has lost connection and needs to
  // understand what happened. White on #ef4444 measured 3.76:1.
  it('keeps the offline banner above AA', () => {
    const background = declaration(indexCss, '.wl-offline-banner', 'background');
    const color = declaration(indexCss, '.wl-offline-banner', 'color');
    expect(background).not.toBeNull();
    expect(color).not.toBeNull();
    expect(contrast(hex(color!), hex(background!))).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('motion preference', () => {
  const reducedMotionBlock = () => {
    const match = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(indexCss);
    expect(match, 'player stylesheet should carry a prefers-reduced-motion block').not.toBeNull();
    return match![1];
  };

  it('honours prefers-reduced-motion somewhere in the player stylesheet', () => {
    expect(indexCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  // An inline `animation` outranks every stylesheet, so a spinner that
  // declares its own animation can never be quieted by a media query.
  // Keeping the rotation on `.wl-spinner` is what makes the guard
  // above reachable at all.
  it('declares no spinner animation inline', () => {
    expect(styles.preloadSpinnerSmall).not.toHaveProperty('animation');
    expect(styles.stalledSpinner).not.toHaveProperty('animation');
    expect(declaration(indexCss, '.wl-spinner', 'animation')).toContain('spin');
  });

  it('substitutes a static ring rather than letting the spinner vanish', () => {
    const reduced = reducedMotionBlock();
    expect(reduced).toMatch(/\.wl-spinner\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/border-color:\s*currentColor\s*!important/);
  });

  it('collapses transitions, which is the only way to reach the inline progress bar', () => {
    // styles.progressBar animates `width` from an inline style, which
    // no ordinary stylesheet rule could override.
    expect(styles.progressBar.transition).toContain('width');
    expect(reducedMotionBlock()).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});

describe('password gate focus', () => {
  // The one control standing between a listener and the story. It set
  // `outline: none` inline with no replacement, so a keyboard user had
  // no way to tell it was focused — and an inline rule cannot express
  // :focus-visible, so the substitute has to live in the stylesheet.
  it('does not suppress the focus ring inline', () => {
    expect(styles.passwordInput).not.toHaveProperty('outline');
  });

  it('provides a visible focus treatment in the stylesheet', () => {
    const outline = declaration(indexCss, '.wl-password-input:focus-visible', 'outline');
    expect(outline).not.toBeNull();
    expect(outline).not.toMatch(/^none/);
  });
});

// The point of item 5: assert the *rules*, not the shipped defaults.
// The old suite hardcoded the default palette, so it guaranteed
// nothing about the colours an author actually picks — which are the
// only colours a listener ever sees.
describe('author-chosen palettes are checked, not just the defaults', () => {
  it('passes the shipped defaults', () => {
    const checks = evaluateThemeContrast(undefined);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.filter((c) => !c.passes)).toEqual([]);
  });

  it('flags text and background set to the same colour', () => {
    const failures = failingThemeContrast({
      variables: { textColor: '#336699', pageBackground: '#336699' },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
    expect(failures.find((f) => f.id === 'text-on-page')!.ratio).toBe(1);
  });

  // The exact trap the character-theme bug came from: a light page
  // under a palette whose text colour was chosen for a dark one.
  it('flags a light page left with dark-theme text', () => {
    const failures = failingThemeContrast({ variables: { pageBackground: '#ffffff' } });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
  });

  // A gradient has to be readable the whole way down, not just at the
  // top stop.
  it('checks every stop of a gradient page background', () => {
    const failures = failingThemeContrast({
      variables: {
        pageBackground: 'linear-gradient(180deg, #ffffff 0%, #000000 100%)',
        textColor: '#ffffff',
      },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
  });

  it('flags an accent dark enough to swallow the start button label', () => {
    // startBtn paints its label #1a1a2e no matter what the accent is.
    const failures = failingThemeContrast({ variables: { accentColor: '#1f2937' } });
    expect(failures.map((f) => f.id)).toContain('start-button');
  });

  it('resolves translucent surfaces against the page rather than guessing', () => {
    // A near-transparent card must inherit the page's readability
    // instead of being treated as opaque white.
    const onDark = evaluateThemeContrast({
      variables: { cardBackground: 'rgba(255,255,255,0.05)' },
    });
    expect(onDark.find((c) => c.id === 'text-on-card')!.passes).toBe(true);
  });

  it('understands hsl() as well as hex and rgb()', () => {
    const failures = failingThemeContrast({
      variables: { pageBackground: 'hsl(0, 0%, 100%)', textColor: 'hsl(0 0% 96%)' },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
  });
});

// The per-component panels sit in the same Theme tab as the global
// knobs, and for several surfaces they are what the player actually
// paints: body copy resolves `var(--wl-page-textColor, var(--wl-text))`
// and the card resolves `var(--wl-storyCard-background, ...)`.
// Checking only the globals would hand a green light to a palette
// nobody can read.
describe('per-component overrides are checked alongside the globals', () => {
  it('flags a Page text override the page background no longer suits', () => {
    // Globals alone would pass here; the override is the whole defect.
    const failures = failingThemeContrast({
      variables: { pageBackground: '#ffffff', textColor: '#111827' },
      components: { page: { textColor: '#eeeeee' } },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
  });

  it('lets a component text override clear a warning the globals would raise', () => {
    // The mirror case: without this the author would be warned forever
    // with no way to satisfy the check.
    const failures = failingThemeContrast({
      variables: { pageBackground: '#ffffff' },
      components: { page: { textColor: '#111827' } },
    });
    expect(failures.map((f) => f.id)).not.toContain('text-on-page');
  });

  it('measures the story card override rather than the global card colour', () => {
    const failures = failingThemeContrast({
      components: { storyCard: { background: '#ffffff' } },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-card');
  });

  it('honours a start-button label override', () => {
    const failures = failingThemeContrast({
      variables: { accentColor: '#1f2937' },
      components: { startButton: { textColor: '#ffffff' } },
    });
    expect(failures.map((f) => f.id)).not.toContain('start-button');
  });

  // The settings panel resolves
  // `var(--wl-settingsPanel-background, var(--wl-chrome, ...))`, so
  // both the component override and the global Chrome knob reach it.
  it('measures the settings panel through both of the knobs that reach it', () => {
    const viaChrome = failingThemeContrast({ variables: { chromeColor: '#eeeeee' } });
    expect(viaChrome.map((f) => f.id)).toContain('text-on-settings-panel');

    const viaComponent = failingThemeContrast({
      components: { settingsPanel: { background: '#eeeeee' } },
    });
    expect(viaComponent.map((f) => f.id)).toContain('text-on-settings-panel');

    // And the component override is the one that wins.
    const both = failingThemeContrast({
      variables: { chromeColor: '#eeeeee' },
      components: { settingsPanel: { background: '#1a1a2e' } },
    });
    expect(both.map((f) => f.id)).not.toContain('text-on-settings-panel');
  });
});

// The settings panel used to hardcode a near-black fill with no
// variable in its chain, so an author who moved to a light theme got
// their dark body text on it at 1.25:1 and no global knob could fix
// it — the Chrome knob, whose own label claims this surface, was read
// by nothing at all.
describe('the Chrome knob reaches the surface its label claims', () => {
  it('puts --wl-chrome in the settings panel chain', () => {
    expect(styles.settingsPanel.background).toContain('--wl-chrome');
  });

  it('keeps the untouched panel looking exactly as it did', () => {
    // The :root default has to equal the colour the panel previously
    // hardcoded, or this becomes a silent restyle of every story.
    const rootDefault = declaration(indexCss, ':root', '--wl-chrome');
    expect(parseColor(rootDefault!)).toEqual(parseColor('rgba(30,30,50,0.95)'));
    expect(styles.settingsPanel.background).toContain('rgba(30,30,50,0.95)');
  });

  it('follows a light theme once the author sets it', () => {
    const failures = failingThemeContrast({
      variables: { pageBackground: '#ffffff', textColor: '#111827', chromeColor: '#f1f5f9' },
    });
    expect(failures.map((f) => f.id)).not.toContain('text-on-settings-panel');
  });
});

// The page is painted by two declarations, and which one wins is not
// "component beats variable":
//
//   background:       var(--wl-page-background,      var(--wl-page-bg));
//   background-image: var(--wl-page-backgroundImage, var(--wl-page-bg));
//
// `background-image` wins the visible layer whenever it resolves to a
// real image. When it resolves to a colour the declaration is invalid
// at computed-value time and falls back to `none`, letting the
// shorthand's colour through. Getting this wrong in either direction
// means warning about a page nobody sees, or clearing one they do.
describe('the page surface follows the player, not the knob names', () => {
  it('lets the page-bg gradient cover a Page → Background colour', () => {
    // Default --wl-page-bg is a dark gradient, which paints over the
    // white component colour, so #eee body text is still fine.
    const failures = failingThemeContrast({ components: { page: { background: '#ffffff' } } });
    expect(failures.map((f) => f.id)).not.toContain('text-on-page');
  });

  it('shows a Page → Background colour once the page variable is a flat colour', () => {
    const failures = failingThemeContrast({
      variables: { pageBackground: '#1a1a2e', textColor: '#1a1a2e' },
      components: { page: { background: '#1a1a2e' } },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
  });

  it('measures a Page → Background image ahead of everything else', () => {
    const failures = failingThemeContrast({
      variables: { pageBackground: '#1a1a2e', textColor: '#eeeeee' },
      components: { page: { backgroundImage: 'linear-gradient(#ffffff, #ffffff)' } },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
  });

  it('falls through a background image cleared with `none`', () => {
    // `none` is how an author clears the image layer; it isn't a
    // colour we failed to read, and the colour underneath is what
    // gets painted.
    const checks = evaluateThemeContrast({
      variables: { pageBackground: '#ffffff', textColor: '#111827' },
      components: { page: { backgroundImage: 'none' } },
    });
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).not.toBeNull();
  });
});

// A check that silently didn't run reads exactly like a check that
// passed, and the place it surfaces is a page captioned "Theme colours
// meet WCAG AA contrast ✓".
describe('colours the parser cannot read are reported, never passed', () => {
  it('marks the pair unevaluated rather than dropping or passing it', () => {
    const checks = evaluateThemeContrast({ variables: { textColor: 'oklch(0.7 0.1 200)' } });
    const check = checks.find((c) => c.id === 'text-on-page');
    expect(check).toBeDefined();
    expect(check!.ratio).toBeNull();
    expect(check!.passes).toBe(false);
    expect(check!.unparsed).toContain('oklch(0.7 0.1 200)');
  });

  it('names the unreadable value so the author knows which one to change', () => {
    const unknown = unevaluatedThemeContrast({ variables: { pageBackground: 'lightgray' } });
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((c) => c.unparsed.includes('lightgray'))).toBe(true);
  });

  it('keeps unevaluated pairs out of the "too low" list', () => {
    const theme = { variables: { textColor: 'oklch(0.7 0.1 200)' } };
    expect(failingThemeContrast(theme).map((c) => c.id)).not.toContain('text-on-page');
    expect(unevaluatedThemeContrast(theme).map((c) => c.id)).toContain('text-on-page');
  });

  it('still measures the pairs the unreadable value has nothing to do with', () => {
    const checks = evaluateThemeContrast({ variables: { textColor: 'oklch(0.7 0.1 200)' } });
    expect(checks.find((c) => c.id === 'heading-on-page')!.ratio).not.toBeNull();
  });

  // A `url()` page background is a first-class option in the Theme
  // tab. We can't sample it and never will, but it sits *behind* every
  // opaque surface — so it says nothing about whether the start
  // button's label is readable, and reporting it there would mark the
  // build's smoke check failed on every story that uses one.
  it('does not let an unsamplable page poison pairs it sits behind', () => {
    const checks = evaluateThemeContrast({
      components: { page: { backgroundImage: 'url(bg.jpg)' } },
    });
    expect(checks.find((c) => c.id === 'start-button')!.ratio).not.toBeNull();
    // The pairs that really do sit on the page are still honest about it.
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).toBeNull();
  });

  // The colour scanner runs over an author-controlled string on every
  // build. With `[^)]*` in the token pattern, `rgb(` repeated with no
  // closing paren made each start position consume the rest of the
  // string before failing — quadratic, and reachable from a stored
  // theme value (CodeQL js/polynomial-redos).
  it('does not degrade on an unclosed colour function repeated at length', () => {
    const hostile = 'rgb('.repeat(20000);
    const started = Date.now();
    const checks = evaluateThemeContrast({ variables: { pageBackground: hostile } });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).toBeNull();
  });

  it('still resolves a translucent surface against the page it shows through', () => {
    // The default card is rgba(255,255,255,0.1), so an unsamplable
    // page genuinely does leave its readability unknown.
    const checks = evaluateThemeContrast({
      components: { page: { backgroundImage: 'url(bg.jpg)' } },
    });
    expect(checks.find((c) => c.id === 'text-on-card')!.ratio).toBeNull();
  });
});
