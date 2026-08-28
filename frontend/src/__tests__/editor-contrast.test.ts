import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AA_NON_TEXT,
  AA_NORMAL_TEXT,
  contrastRatio,
  extractColors,
  flatten,
  parseColor,
  type Rgb,
} from '@wanderline/shared';

// Contrast rules for the editor's own chrome.
//
// The graph's "dim unreachable nodes" overlay is the interesting one.
// It exists so an author can still SEE the nodes a path can't reach
// rather than have them disappear — but it was implemented as
// `opacity: 0.32` on the whole card, which dragged the node title down
// to 2.07:1 (search-unmatched, at 0.35, reached 2.24:1). A low-vision
// author couldn't read them, so for that author the feature had
// quietly become "hide unreachable nodes". Path membership had the
// mirror-image problem: signalled by an amber border at 2.15:1 and by
// nothing else at all.
//
// These assert the rules — measured ratios against the WCAG floors —
// rather than pinning the specific colours, so the numbers can move as
// long as they stay legal.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}[^{]*\\{([^}]*)\\}`).exec(css);
  expect(match, `expected a rule for ${selector}`).not.toBeNull();
  return match![1];
}

function declaration(selector: string, property: string): string | null {
  const decl = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(rule(selector));
  return decl ? decl[1].trim() : null;
}

function customProperty(name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+)`).exec(css);
  expect(match, `expected ${name} to be defined`).not.toBeNull();
  return match![1].trim();
}

function rgb(value: string): Rgb {
  const parsed = parseColor(value);
  expect(parsed, `expected ${value} to parse as a colour`).not.toBeNull();
  return parsed!.rgb;
}

const SURFACE = rgb('#ffffff'); // --color-surface
const PAGE = rgb('#f9fafb'); // --color-bg
const NODE_TITLE = rgb('#0f172a'); // .graph-node-card-title

// Every card fill the dim wash can land on: the plain card, plus the
// state washes that .is-error / .is-missing and .is-warning set.
const CARD_FILLS: Array<[string, Rgb]> = [
  ['plain card', SURFACE],
  ['error card', rgb('#fef2f2')],
  ['warning card', rgb('#fffbeb')],
];

/** The dim wash composited over one of the card fills. */
function dimSurfaceOver(base: Rgb): Rgb {
  const wash = declaration('.graph-node-card.is-dim', 'background-image');
  expect(wash, 'the dim state should paint a wash').not.toBeNull();
  const stops = extractColors(wash!);
  expect(stops.length).toBeGreaterThan(0);
  return flatten([stops[0]], base);
}

describe('dimmed graph nodes stay readable', () => {
  // The whole point of the fix: de-emphasis is a property of the
  // surface, not of the ink. `opacity` on the card takes the text with
  // it and there is no floor at which both the title and the muted
  // footer survive.
  for (const selector of ['.graph-node-card.is-dim', '.graph-node-card.is-unmatched']) {
    it(`${selector} washes the surface instead of fading the whole card`, () => {
      expect(declaration(selector, 'opacity')).toBeNull();
      expect(declaration(selector, 'background-image')).not.toBeNull();
      for (const [name, base] of CARD_FILLS) {
        const ratio = contrastRatio(NODE_TITLE, dimSurfaceOver(base));
        expect(ratio, `node title on a dimmed ${name}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    });
  }

  it('darkens the muted footer to clear AA under the wash', () => {
    // #6b7280 (--color-text-muted) is only 4.15:1 under the wash, so
    // the dim state has to override it rather than inherit it.
    const footer = rgb(declaration('.graph-node-card.is-dim .graph-node-card-footer', 'color')!);
    for (const [name, base] of CARD_FILLS) {
      const ratio = contrastRatio(footer, dimSurfaceOver(base));
      expect(ratio, `footer on a dimmed ${name}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('is still visibly recessed against an undimmed card', () => {
    // A readable dim state that looked identical to a normal one would
    // have traded one problem for another.
    expect(contrastRatio(dimSurfaceOver(SURFACE), SURFACE)).toBeGreaterThan(1.15);
  });

  // The dim selectors have the same specificity as .is-error,
  // .is-warning, .is-selected and :hover but come later in the file,
  // so any `background`, `border-color` or `box-shadow` here would win
  // outright — a dimmed error node would lose the red border that says
  // it's broken, and a dimmed selected node would lose its ring. The
  // wash goes on `background-image`, which leaves `background-color`
  // and the borders to the state rules.
  it('leaves the state rules alone so an error or a selection survives dimming', () => {
    for (const selector of ['.graph-node-card.is-dim', '.graph-node-card.is-unmatched']) {
      expect(declaration(selector, 'background'), `${selector} background`).toBeNull();
      expect(declaration(selector, 'border-color'), `${selector} border-color`).toBeNull();
      expect(declaration(selector, 'box-shadow'), `${selector} box-shadow`).toBeNull();
    }
  });

  // A translucent wash needs an opaque card under it. The flat-fill
  // states provide one, but .is-start and .is-ending paint their tints
  // with the `background` shorthand, which resets background-color to
  // transparent — a start or ending node excluded by a search would
  // have had the wash composite over the ReactFlow canvas.
  for (const state of ['is-start', 'is-ending']) {
    it(`gives a dimmed .${state} node an opaque fill to be washed over`, () => {
      const fill = declaration(`.graph-node-card.${state}.is-dim`, 'background-color');
      expect(fill, `a dimmed .${state} node needs an opaque background-color`).not.toBeNull();
      expect(parseColor(fill!)!.alpha).toBe(1);
      expect(contrastRatio(NODE_TITLE, dimSurfaceOver(rgb(fill!)))).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    });
  }

  // Whether the opaque fill may stand aside for a validation state
  // depends on declaration order, not on the fill's own specificity.
  // `.is-start` is declared before .is-error/.is-warning/.is-missing,
  // so those win on a node carrying both and supply their own fill.
  // `.is-ending` is declared after them, so its gradient wins and
  // there is no background-color to defer to — excluding it would
  // leave a dimmed, broken ending node transparent under the wash.
  //
  // This is also the guard for the next state someone adds: any card
  // state painting with the `background` shorthand leaves no
  // background-color for the wash, so it has to appear here.
  it('gives every gradient-filled state a fill, deferring only where the cascade allows', () => {
    const ruleStart = (selector: string) => css.indexOf(`\n${selector} {`);
    const validationStates = ['is-error', 'is-warning', 'is-missing'];
    const lastValidation = Math.max(
      ...validationStates.map((s) => ruleStart(`.graph-node-card.${s}`)),
    );
    expect(lastValidation).toBeGreaterThan(0);

    const gradientStates = [...css.matchAll(/\.graph-node-card\.(is-[a-z-]+)\s*\{([^}]*)\}/g)]
      .filter(([, , body]) => /(?:^|;)\s*background\s*:[^;]*gradient\(/.test(body))
      .map(([, state]) => state);
    expect(gradientStates.length).toBeGreaterThan(0);

    const opaqueFill = css.slice(css.indexOf('.graph-node-card.is-start.is-dim'));
    const selectors = opaqueFill.slice(0, opaqueFill.indexOf('{'));

    for (const state of gradientStates) {
      for (const overlay of ['is-dim', 'is-unmatched']) {
        const selector = selectors
          .split(',')
          .map((s) => s.trim())
          .find((s) => s.startsWith(`.graph-node-card.${state}.${overlay}`));
        expect(selector, `.${state}.${overlay} needs an opaque fill`).toBeDefined();

        // Declared after the validation states? Then its gradient
        // beats their fills and it must not defer to them.
        const deferrable = ruleStart(`.graph-node-card.${state}`) < lastValidation;
        for (const guard of validationStates) {
          if (deferrable) {
            expect(selector, `.${state} should defer to .${guard}`).toContain(`:not(.${guard})`);
          } else {
            expect(selector, `.${state} outranks .${guard}, so it cannot defer`).not.toContain(
              `:not(.${guard})`,
            );
          }
        }
      }
    }
  });
});

describe('graph overlay borders carry enough contrast to mean something', () => {
  // WCAG 1.4.11: a boundary that identifies state needs 3:1.
  it('the on-path border clears the non-text minimum', () => {
    const border = rgb(declaration('.graph-node-card.is-on-path', 'border-color')!);
    expect(contrastRatio(border, SURFACE)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    // A node can be on the path and dimmed at the same time, so the
    // border has to clear the bar under the wash too.
    for (const [name, base] of CARD_FILLS) {
      const ratio = contrastRatio(border, dimSurfaceOver(base));
      expect(ratio, `on-path border on a dimmed ${name}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it('the search-match border clears the non-text minimum', () => {
    const border = rgb(declaration('.graph-node-card.is-matched', 'border-color')!);
    expect(contrastRatio(border, SURFACE)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  // Colour alone can't carry state (WCAG 1.4.1), and a border carries
  // nothing at all to a screen reader.
  it('backs the on-path border with a readable text marker', () => {
    const chip = rule('.graph-node-path-chip');
    expect(chip).toBeTruthy();
    const color = rgb(declaration('.graph-node-path-chip', 'color')!);
    const background = rgb(declaration('.graph-node-path-chip', 'background')!);
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('control boundaries', () => {
  // --color-border is 1.24:1 on white. Fine for a decorative divider,
  // not fine as the only thing marking where a text field is.
  it('form controls use a border that clears the non-text minimum on both surfaces', () => {
    const control = rgb(customProperty('--color-border-control'));
    expect(contrastRatio(control, SURFACE)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrastRatio(control, PAGE)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(declaration("input[type='text']", 'border')).toContain('--color-border-control');
  });
});

describe('keyboard focus is always visible', () => {
  // Suppressing an outline is only acceptable when something visible
  // replaces it. The global input rule does that (indigo border +
  // ring); the Ink editor did not.
  it('replaces the CodeMirror focus outline instead of just removing it', () => {
    const outline = declaration('.ink-source-host .cm-focused', 'outline');
    expect(outline).not.toBeNull();
    expect(outline).not.toMatch(/^none/);
    expect(contrastRatio(rgb('#4f46e5'), SURFACE)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe('motion preference', () => {
  it('keeps a static substitute for the animated start-node pulse', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/animation:\s*none/);
    expect(block![1]).toMatch(/box-shadow:/);
  });
});
