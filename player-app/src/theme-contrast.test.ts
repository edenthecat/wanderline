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
  themeContrastMayBeOverridden,
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
// Four rendered surfaces (choice buttons, the instructions card, the
// resume picker, the error banner) and the password field's focus ring
// were never in PAIRS at all — an author could set a choice button's
// background and text to the same colour and every check would still
// come back green, because nothing was measuring that pair. Each test
// here fails against the OLD PAIRS list (the surface simply wasn't
// checked) and passes now.
describe('every rendered surface the theme editor can touch is checked', () => {
  it('checks the choice button, not just the story card', () => {
    const failures = failingThemeContrast({
      components: { choiceButton: { background: '#eeeeee', textColor: '#eeeeee' } },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-choice-button');
  });

  it('checks the instructions card', () => {
    const failures = failingThemeContrast({
      components: { instructionsCard: { background: '#eeeeee', textColor: '#eeeeee' } },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-instructions-card');
  });

  it('checks the resume picker through the instructions card it sits inside', () => {
    // Nested, not a sibling of the card — a translucent picker
    // background measured against the page alone (skipping the card)
    // would land on the wrong backdrop.
    const failures = failingThemeContrast({
      components: {
        instructionsCard: { background: '#000000' },
        resumePicker: { textColor: '#000000' },
      },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-resume-picker');

    // And the reverse: a picker override alone, without touching the
    // card, is still measured against whatever the card resolves to.
    const clean = failingThemeContrast({
      components: { resumePicker: { textColor: '#eeeeee' } },
    });
    expect(clean.map((f) => f.id)).not.toContain('text-on-resume-picker');
  });

  it('checks the error banner', () => {
    const failures = failingThemeContrast({
      components: { errorBanner: { textColor: '#d9534f' } },
    });
    expect(failures.map((f) => f.id)).toContain('text-on-error-banner');
  });

  it('checks the password field focus ring against the light theme it turns out to fail', () => {
    // The default accent (#4ecdc4) is fine on the default dark page but
    // loses most of its contrast once the page — and so the password
    // card's translucent white wash — goes light. Nothing warned about
    // this before the ring had its own pair.
    const failures = failingThemeContrast({
      variables: { pageBackground: '#ffffff', accentColor: '#4ecdc4' },
    });
    expect(failures.map((f) => f.id)).toContain('password-focus-ring');

    // A darker accent restores it.
    const fixed = failingThemeContrast({
      variables: { pageBackground: '#ffffff', accentColor: '#0f766e' },
    });
    expect(fixed.map((f) => f.id)).not.toContain('password-focus-ring');
  });
});

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
  // styles.header paints `var(--wl-header-background, transparent)`.
  // A filled header bar is what the title actually sits on, so
  // measuring it against the page would raise a warning the author has
  // no way to satisfy — the fastest way to teach someone to ignore the
  // panel.
  it('measures the title against a filled header bar, not the page behind it', () => {
    const onHeader = failingThemeContrast({
      variables: { pageBackground: '#ffffff', headingColor: '#ffffff' },
      components: { header: { background: '#111827' } },
    });
    expect(onHeader.map((f) => f.id)).not.toContain('heading-on-page');

    // And the default transparent header still lets the page through.
    const onPage = failingThemeContrast({
      variables: { pageBackground: '#ffffff', headingColor: '#ffffff' },
    });
    expect(onPage.map((f) => f.id)).toContain('heading-on-page');
  });

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

  it('does not silently fall through a component override literally set to none', () => {
    // renderThemeCss forwards `none` verbatim for every component prop,
    // not just the page background's dedicated handling above. Falling
    // through to --wl-card-bg here — what this used to do — measured a
    // colour the player never paints: `background: none` on the story
    // card is valid CSS with real, different consequences (transparent,
    // showing the page through) that this generic resolver has no way
    // to model precisely, so it is reported as unmeasured rather than
    // guessed via the global.
    const checks = evaluateThemeContrast({
      variables: { cardBackground: '#ffffff', textColor: '#eeeeee' },
      components: { storyCard: { background: 'none' } },
    });
    const card = checks.find((c) => c.id === 'text-on-card')!;
    expect(card.ratio).toBeNull();
    expect(card.unparsed).toContain('none');
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

  // Project settings are merged into the row verbatim — no per-field
  // validation — so any theme prop can hold a number, an array or an
  // object. Before this module existed such values were inert;
  // throwing on one here would fail every subsequent build of that
  // project, and throw inside the Theme tab's debounce timer.
  it('survives theme values that are not strings at all', () => {
    const hostile = {
      variables: { pageBackground: 42 as unknown as string },
      components: {
        page: { backgroundImage: 123 as unknown as string, background: [] as unknown as string },
        storyCard: { background: {} as unknown as string },
      },
    };
    expect(() => evaluateThemeContrast(hostile)).not.toThrow();
    // And it agrees with the player about what happens next:
    // renderThemeCss skips non-strings, so those knobs never reach the
    // page and the shipped defaults are what a listener sees.
    expect(evaluateThemeContrast(hostile)).toEqual(evaluateThemeContrast(undefined));
  });

  it('ignores a colour typed into Page → Background image', () => {
    // The field is free text, so a colour lands in it easily — and
    // `background-image: #000000` is invalid at computed-value time,
    // computes to `none`, and paints nothing. Trusting it as the
    // surface scored this palette at 21:1 and handed out a green tick
    // for a page the player renders white-on-white.
    const checks = evaluateThemeContrast({
      variables: { pageBackground: '#ffffff', textColor: '#ffffff' },
      components: { page: { backgroundImage: '#000000' } },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    expect(page.ratio).toBe(1);
    expect(page.passes).toBe(false);
  });

  it('wipes the gradient when the image layer is switched off', () => {
    // `background-image` is declared after the shorthand, so a value
    // that computes to `none` takes the shorthand's gradient with it —
    // leaving the background-color, which a gradient page never set.
    // The listener gets #eee on the browser's white canvas.
    const failures = failingThemeContrast({ components: { page: { backgroundImage: 'none' } } });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
  });

  it('samples a gradient typed into Page → Background instead of giving up', () => {
    // That knob feeds the `background` shorthand, where a gradient
    // paints as the image layer. Putting it into `beneath` — which
    // only ever holds a flat colour — made parseColor return null and
    // reported the whole page as unmeasurable, for a surface
    // samplePageStops reads perfectly well.
    const checks = evaluateThemeContrast({
      components: { page: { background: 'linear-gradient(#000000, #111111)' } },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    expect(page.ratio).not.toBeNull();
    expect(page.unparsed).toEqual([]);
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

describe('the page background can be explicitly cleared', () => {
  it('shows the browser canvas when Page -> Background is set to none', () => {
    // `background: none` is valid CSS on the shorthand itself (`none`
    // is an acceptable <bg-image> token), unlike backgroundImage's
    // `none`, which just wipes the image layer. It clears the whole
    // shorthand's own colour role too, so the canvas shows through —
    // not the dark global default, which is what treating this `none`
    // as "unset" used to fall through to.
    const checks = evaluateThemeContrast({
      variables: { pageBackground: '#1a1a2e', textColor: '#f5f5f5' },
      components: { page: { background: 'none' } },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    // #f5f5f5 on white is a near-fail, not the ~14:1 the dark default
    // would have reported.
    expect(page.ratio).not.toBeNull();
    expect(page.ratio!).toBeLessThan(2);
    expect(page.passes).toBe(false);
  });
});

describe('gradients are sampled between stops, not only at them', () => {
  it('fails a mid-grey that only crosses the gradient in the middle', () => {
    // #767676 is famously the grey that sits right at 4.5:1 against
    // white — the endpoints of a black-to-white gradient individually
    // read as fine (black: high contrast; white: right at the
    // boundary), but the gradient interpolates continuously through
    // every shade of grey in between, including one indistinguishable
    // from the text itself. Sampling only the two stops — what this
    // used to do — missed that crossing entirely.
    const checks = evaluateThemeContrast({
      variables: { pageBackground: 'linear-gradient(#000000, #ffffff)', textColor: '#767676' },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    expect(page.ratio).not.toBeNull();
    expect(page.passes).toBe(false);
    expect(page.ratio!).toBeLessThan(2);
  });

  it('still passes a gradient with genuinely good contrast throughout', () => {
    // Guards against the interpolation itself introducing false
    // failures — a light gradient against dark text should stay clean
    // at every sampled point, not just the two ends.
    const checks = evaluateThemeContrast({
      variables: { pageBackground: 'linear-gradient(#f5f5f5, #e5e5e5)', textColor: '#111111' },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    expect(page.passes).toBe(true);
  });
});

describe('multi-layer backgrounds', () => {
  it('reads a trailing solid colour on the shorthand as the true backdrop', () => {
    // CSS allows exactly one plain colour, on the LAST layer of a
    // multi-layer `background:` value. Backing this with a separate,
    // clean single-layer image (in backgroundImage) isolates the
    // shorthand's colour role from the image-declaration checks below
    // — this is testing specifically that the trailing #111111 becomes
    // the backdrop the image composites over, not white.
    const checks = evaluateThemeContrast({
      variables: { textColor: '#666666' },
      components: {
        page: {
          background: 'linear-gradient(rgba(0,0,0,.2), rgba(0,0,0,.2)), #111111',
          backgroundImage: 'linear-gradient(rgba(255,255,255,.5), rgba(255,255,255,.5))',
        },
      },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    // The scrim composites to roughly #888 over the correct #111
    // backdrop; #666 text there is 1.6:1, a clear fail. Composited
    // over a wrongly-assumed white canvas instead it would come out
    // close to white and pass outright — the false-pass the trailing
    // colour being ignored used to produce.
    expect(page.ratio).not.toBeNull();
    expect(page.passes).toBe(false);
  });

  it('does not double-composite a translucent flat page colour', () => {
    // With no separate image layer, the flat/translucent shorthand
    // paints directly onto the canvas ONCE. Reporting it as both the
    // layer and the backdrop composited it twice: white text on
    // rgba(0,0,0,.5) measured against roughly #404040 (double
    // composite) instead of the correct ~#808080 — 3.95:1, just under
    // AA, exactly the false-pass Copilot's review flagged.
    const checks = evaluateThemeContrast({
      variables: { pageBackground: 'rgba(0,0,0,.5)', textColor: '#ffffff' },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    expect(page.ratio).not.toBeNull();
    // The correct single-composite surface (~#808080) is darker than
    // the buggy double-composite one (~#404040), which counterintuitively
    // means it has LESS contrast against white — the honest failure the
    // bug was hiding behind a false pass.
    expect(page.passes).toBe(false);
    expect(page.ratio!).toBeCloseTo(3.95, 1);
  });

  it('treats a multi-layer background-image with a trailing colour as no image at all', () => {
    // Unlike the shorthand, `background-image` alone has no colour
    // sub-property — every layer must be an image or the WHOLE
    // declaration is invalid at computed-value time. Per the custom
    // properties spec an invalid declaration still wins its cascade
    // slot, resolving to the property's initial value (`none`) rather
    // than falling back to whatever an earlier declaration set — so
    // the gradient here never renders at all, only the flat colour
    // underneath does.
    const checks = evaluateThemeContrast({
      variables: { pageBackground: '#111111', textColor: '#666666' },
      components: {
        page: { backgroundImage: 'linear-gradient(rgba(0,0,0,.2), rgba(0,0,0,.2)), #111111' },
      },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    // Measured, not guessed: this is the SAME as never having set
    // backgroundImage at all — the invalid declaration there discards
    // its image layer entirely, leaving only the flat #111111 the
    // shorthand's own colour role already carried.
    const flatEquivalent = evaluateThemeContrast({
      variables: { pageBackground: '#111111', textColor: '#666666' },
    }).find((c) => c.id === 'text-on-page')!;
    expect(page.ratio).toEqual(flatEquivalent.ratio);
    expect(page.passes).toBe(flatEquivalent.passes);
  });

  it('reports a bare var() in the image field as genuinely unmeasured', () => {
    // Unlike the trailing-colour case above, CSS itself cannot resolve
    // this without the author's own custom CSS defining the variable —
    // there is a real image behind it or there is nothing, and this
    // module has no way to tell which.
    const checks = evaluateThemeContrast({
      components: { page: { backgroundImage: 'var(--my-custom-bg)' } },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    expect(page.ratio).toBeNull();
    expect(page.passes).toBe(false);
    expect(page.unparsed).toContain('var(--my-custom-bg)');
  });
});

// A check that silently didn't run reads exactly like a check that
// passed, and the place it surfaces is a page captioned "Theme colours
// meet WCAG AA contrast ✓".
describe('the colour parser refuses what it cannot actually read', () => {
  it('reads every CSS angle unit the same way the browser does', () => {
    // Number.parseFloat took the digits and dropped the unit, so half
    // a turn — cyan — came out as hue 0.5, which is red, with a
    // confident contrast ratio attached to it.
    const cyan = parseColor('hsl(180deg 100% 50%)');
    expect(cyan).not.toBeNull();
    expect(parseColor('hsl(0.5turn 100% 50%)')).toEqual(cyan);
    expect(parseColor('hsl(200grad 100% 50%)')).toEqual(cyan);
    const rad = parseColor('hsl(3.14159rad 100% 50%)')!;
    // Radians don't land on an exact integer channel; near enough.
    expect(rad.rgb[0]).toBeCloseTo(cyan!.rgb[0], 2);
    expect(rad.rgb[1]).toBeCloseTo(cyan!.rgb[1], 2);
  });

  it('rejects a hue or component carrying a unit that is not an angle', () => {
    expect(parseColor('hsl(180px 100% 50%)')).toBeNull();
    expect(parseColor('hsl(180 100px 50%)')).toBeNull();
    expect(parseColor('hsl(banana 100% 50%)')).toBeNull();
  });

  it('rejects an alpha that was written but cannot be read', () => {
    // Defaulting to 1 made this opaque black — the most contrasting
    // thing available — for a declaration the browser discards
    // outright. The checker was scoring a surface nobody paints.
    expect(parseColor('rgba(0,0,0,banana)')).toBeNull();
    expect(parseColor('rgb(0 0 0 / banana)')).toBeNull();
    expect(parseColor('rgb(0 0 0 / )')).toBeNull();
    // A real alpha still reads, and an absent one is still 1.
    expect(parseColor('rgba(0,0,0,0.5)')).toEqual({ rgb: [0, 0, 0], alpha: 0.5 });
    expect(parseColor('rgb(0,0,0)')).toEqual({ rgb: [0, 0, 0], alpha: 1 });
    expect(parseColor('rgba(0,0,0,50%)')).toEqual({ rgb: [0, 0, 0], alpha: 0.5 });
  });

  it('does not go quadratic on a long run of digits', () => {
    // The number regexes guarding alpha, hue, saturation and lightness
    // all take author-controlled theme text. `\d+\.?\d*` lets a digit
    // run be divided between two quantifiers in as many ways as it is
    // long, so an anchored match that fails at the end backtracks
    // through every one — CodeQL js/polynomial-redos.
    //
    // An absolute ceiling rather than a ratio: the fixed parser runs
    // this in well under a millisecond, and comparing two
    // sub-millisecond timings measures noise. The old shape took 52ms
    // at 8k digits, so 32k — four times that, sixteen times the work —
    // would be roughly 800ms. 150ms sits an order of magnitude above
    // anything linear and comfortably below anything quadratic, so a
    // slow CI box cannot trip it and a regression cannot hide under it.
    const value = `rgba(0,0,0,${'0'.repeat(32000)}x)`;
    parseColor(`rgba(0,0,0,${'0'.repeat(4000)}x)`); // warm the JIT
    const start = performance.now();
    expect(parseColor(value)).toBeNull();
    expect(performance.now() - start).toBeLessThan(150);
  });

  it('rejects an rgb() channel that is not a clean CSS number', () => {
    // parseChannel used Number.parseFloat with no grammar check, so it
    // read the leading digits and threw away everything after —
    // `rgb(255,0,0junk)` parsed as channel 0 for a declaration the
    // browser discards outright, the same shape of bug already fixed
    // for alpha and hue.
    expect(parseColor('rgb(255,0,0junk)')).toBeNull();
    expect(parseColor('rgb(1e2,0,0)')).toEqual({ rgb: [100, 0, 0], alpha: 1 });
    expect(parseColor('rgb(100%,0,0)')).toEqual({ rgb: [255, 0, 0], alpha: 1 });
  });

  it('rejects a second slash in the space + alpha syntax', () => {
    // `args.split('/')` returns every segment; destructuring only the
    // first two silently dropped anything past a second slash, so
    // `rgb(0 0 0 / 0.5 / 0)` — invalid CSS the browser rejects outright
    // — read as alpha 0.5 instead of failing.
    expect(parseColor('rgb(0 0 0 / 0.5 / 0)')).toBeNull();
    expect(parseColor('rgb(0 0 0 / 0.5)')).toEqual({ rgb: [0, 0, 0], alpha: 0.5 });
  });

  it('carries an unreadable alpha up into an unmeasured verdict', () => {
    const checks = evaluateThemeContrast({
      variables: { pageBackground: '#ffffff', textColor: 'rgba(0,0,0,banana)' },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    expect(page.ratio).toBeNull();
    expect(page.passes).toBe(false);
  });
});

describe('custom CSS is not something this can vouch for', () => {
  it('flags the verdict as overridable when the author wrote custom CSS', () => {
    // renderThemeCss appends customCss after the :root block, so one
    // `body { color: #fff !important }` beats every variable measured
    // here — and nothing here parses it. A silent warning list and a
    // green tick both read as "your palette is fine", which is not a
    // claim this module is in a position to make.
    expect(themeContrastMayBeOverridden(undefined)).toBe(false);
    expect(themeContrastMayBeOverridden({ variables: { textColor: '#111' } })).toBe(false);
    expect(themeContrastMayBeOverridden({ customCss: '   ' })).toBe(false);
    expect(themeContrastMayBeOverridden({ customCss: 'body { color: #fff }' })).toBe(true);
  });

  it('still reports the pairs it measured', () => {
    // The measurements are what the knobs produce and stay useful;
    // only the claim of completeness is withdrawn.
    const checks = evaluateThemeContrast({
      variables: { pageBackground: '#ffffff', textColor: '#111827' },
      customCss: 'body { color: #fff !important }',
    });
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).not.toBeNull();
  });
});

describe('the ratio is compared before it is rounded', () => {
  it('does not round a near-miss up into a pass', () => {
    // #ffffff on #6363f8 is 4.4961:1 — below the 4.5 AA floor.
    // Rounding to 2dp first turned that into "4.5:1, passes", which is
    // the checker issuing the exact false green tick it exists to
    // prevent. The displayed 4.5 is fine; the verdict is not.
    const checks = evaluateThemeContrast({
      variables: { pageBackground: '#6363f8', textColor: '#ffffff' },
    });
    const page = checks.find((c) => c.id === 'text-on-page')!;
    expect(page.ratio).toBe(4.5);
    expect(page.passes).toBe(false);
  });

  it('still passes a pair that genuinely clears the floor', () => {
    const checks = evaluateThemeContrast({
      variables: { pageBackground: '#ffffff', textColor: '#595959' },
    });
    expect(checks.find((c) => c.id === 'text-on-page')!.passes).toBe(true);
  });
});

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

  // The Page → Background image hint suggests exactly this shape.
  // `extractColors` finds the scrim's stops and ignores the photo, so
  // scoring it would mean flattening the scrim over white and calling
  // that the page — a confident verdict about a surface nobody sampled,
  // in either direction.
  it('refuses to score a scrim layered over an image it cannot sample', () => {
    const checks = evaluateThemeContrast({
      components: {
        page: {
          backgroundImage: 'linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.6)), url(photo.jpg)',
        },
      },
    });
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).toBeNull();
  });

  it('still scores a gradient whose every stop it can read', () => {
    const checks = evaluateThemeContrast({
      components: { page: { backgroundImage: 'linear-gradient(#1a1a2e 0%, #16213e 100%)' } },
    });
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).not.toBeNull();
  });

  it('refuses to score a gradient with one stop in a syntax it does not model', () => {
    const checks = evaluateThemeContrast({
      components: { page: { backgroundImage: 'linear-gradient(#1a1a2e, oklch(0.7 0.1 200))' } },
    });
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).toBeNull();
  });

  // A stop that isn't a function has no parens for a function-name
  // check to catch. `linear-gradient(lightgray, #111111)` scored
  // 18.88:1 — a green tick for a page whose top half is white text on
  // light grey — because the unreadable stop was simply dropped.
  it.each([
    ['a keyword outside the small named map', 'linear-gradient(lightgray, #111111)'],
    ['currentColor', 'linear-gradient(currentColor, #111111)'],
    ['a hex length that is not a colour', 'linear-gradient(#abcde, #111111)'],
  ])('refuses to score a gradient containing %s', (_label, background) => {
    const checks = evaluateThemeContrast({
      variables: { textColor: '#ffffff' },
      components: { page: { backgroundImage: background } },
    });
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).toBeNull();
  });

  it('still scores the gradient grammar it does understand', () => {
    const checks = evaluateThemeContrast({
      components: {
        page: { backgroundImage: 'repeating-linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)' },
      },
    });
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).not.toBeNull();
  });

  // The image layer can be translucent, and what shows through is the
  // shorthand's background-color — not the browser canvas. Flattening
  // a 20%-black scrim over white called a dark page 1.38:1 and failed
  // the smoke check on a build that renders at ~14:1.
  it('composites a translucent page image over the colour beneath it', () => {
    const checks = evaluateThemeContrast({
      variables: { pageBackground: '#1a1a2e' },
      components: {
        page: { backgroundImage: 'linear-gradient(rgba(0,0,0,0.2), rgba(0,0,0,0.2))' },
      },
    });
    const onPage = checks.find((c) => c.id === 'text-on-page')!;
    expect(onPage.passes).toBe(true);
    expect(onPage.ratio!).toBeGreaterThan(10);
  });

  // `none` is how an author clears a knob. Returning it verbatim left
  // the Theme tab showing a permanent "Couldn't check these — none".
  it('treats a page background cleared with `none` as no override', () => {
    const checks = evaluateThemeContrast({
      components: { page: { backgroundImage: 'none', background: 'none' } },
    });
    expect(checks.find((c) => c.id === 'text-on-page')!.ratio).not.toBeNull();
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

describe('pathological theme values', () => {
  it('does not go quadratic on a long run of word characters', () => {
    // CodeQL js/polynomial-redos. The function-name scan was written
    // `([a-zA-Z][\w-]*)\(` — on a value with no paren, every failure
    // restarted the match INSIDE the identifier it had just consumed,
    // so cost grew with the square of the length. `pageBackground` is
    // author-supplied, so this was reachable by anyone who could set a
    // theme.
    //
    // Timing is a blunt instrument for a unit test, but the difference
    // here is orders of magnitude: the quadratic form takes seconds on
    // this input, the linear form is imperceptible. The bound is loose
    // enough not to flake on a loaded CI box.
    const hostile = 'A'.repeat(60_000);
    const started = Date.now();
    const checks = evaluateThemeContrast({ variables: { pageBackground: hostile } });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    // And it still reaches the right answer: an unparseable background
    // is reported as unmeasured, never silently passed.
    expect(checks.length).toBeGreaterThan(0);
  });

  it('still recognises a real gradient after the change', () => {
    // The optional-paren rewrite must not stop function names being
    // detected, or every gradient would fall through as unsamplable.
    const checks = evaluateThemeContrast({
      variables: {
        pageBackground: 'linear-gradient(to bottom, #ffffff, #000000)',
        textColor: '#000000',
      },
    });
    expect(checks.some((c) => c.ratio !== null)).toBe(true);
  });
});
