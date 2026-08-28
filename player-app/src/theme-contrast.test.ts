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
    const failures = failingThemeContrast({ textColor: '#336699', pageBackground: '#336699' });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
    expect(failures.find((f) => f.id === 'text-on-page')!.ratio).toBe(1);
  });

  // The exact trap the character-theme bug came from: a light page
  // under a palette whose text colour was chosen for a dark one.
  it('flags a light page left with dark-theme text', () => {
    const failures = failingThemeContrast({ pageBackground: '#ffffff' });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
  });

  // A gradient has to be readable the whole way down, not just at the
  // top stop.
  it('checks every stop of a gradient page background', () => {
    const failures = failingThemeContrast({
      pageBackground: 'linear-gradient(180deg, #ffffff 0%, #000000 100%)',
      textColor: '#ffffff',
    });
    expect(failures.map((f) => f.id)).toContain('text-on-page');
  });

  it('flags an accent dark enough to swallow the start button label', () => {
    // startBtn paints its label #1a1a2e no matter what the accent is.
    const failures = failingThemeContrast({ accentColor: '#1f2937' });
    expect(failures.map((f) => f.id)).toContain('start-button');
  });

  it('resolves translucent surfaces against the page rather than guessing', () => {
    // A near-transparent card must inherit the page's readability
    // instead of being treated as opaque white.
    const onDark = evaluateThemeContrast({ cardBackground: 'rgba(255,255,255,0.05)' });
    expect(onDark.find((c) => c.id === 'text-on-card')!.passes).toBe(true);
  });

  it('stays silent on values it cannot parse instead of inventing a number', () => {
    const checks = evaluateThemeContrast({ textColor: 'var(--something-else)' });
    expect(checks.some((c) => c.id === 'text-on-page')).toBe(false);
    // Pairs that don't involve the unparseable value still report.
    expect(checks.some((c) => c.id === 'heading-on-page')).toBe(true);
  });
});
