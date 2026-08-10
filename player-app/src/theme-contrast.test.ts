import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { styles } from './styles';

// Guards for two theming defects an author hit on a released build:
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
// Both were invisible to the existing suite because they only appear
// once a theme is applied and the content is long enough to scroll.

const here = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(here, 'index.css'), 'utf8');

/** WCAG 2.x relative luminance for an sRGB triple. */
function luminance([r, g, b]: number[]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: number[], bg: number[]): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Composite a colour at `alpha` over an opaque backdrop. */
function composite(top: number[], bottom: number[], alpha: number): number[] {
  return [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha));
}

function hex(h: string): number[] {
  const v = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}

// The shipped defaults these rules resolve against.
const ACCENT = hex('#4ecdc4'); // --wl-accent
const PAGE_BG = hex('#1a1a2e'); // first stop of the --wl-page-bg gradient
const BODY_TEXT = hex('#eeeeee'); // --wl-text
const AA_NORMAL = 4.5;

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

  it('keeps #root off a percentage height that would resolve to auto', () => {
    const rule = indexCss.match(/#root\s*\{[\s\S]*?\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).not.toMatch(/^\s*height:\s*100%/m);
  });

  // The viewport fill the layout actually depends on lives here, so if
  // this ever goes away the min-height change above needs revisiting.
  it('still fills the viewport via the app container', () => {
    expect(styles.container.minHeight).toBe('100vh');
  });
});
