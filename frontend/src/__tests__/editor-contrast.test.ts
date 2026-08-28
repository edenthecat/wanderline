import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AA_NON_TEXT,
  AA_NORMAL_TEXT,
  contrastRatio,
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

describe('dimmed graph nodes stay readable', () => {
  // The whole point of the fix: de-emphasis is a property of the
  // surface, not of the ink. `opacity` on the card takes the text with
  // it and there is no floor at which both the title and the muted
  // footer survive.
  for (const selector of ['.graph-node-card.is-dim', '.graph-node-card.is-unmatched']) {
    it(`${selector} recesses the surface instead of fading the whole card`, () => {
      expect(declaration(selector, 'opacity')).toBeNull();
      const background = declaration(selector, 'background');
      expect(background).not.toBeNull();

      const surface = rgb(background!);
      expect(contrastRatio(NODE_TITLE, surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  }

  it('darkens the muted footer to clear AA on the recessed surface', () => {
    // #6b7280 (--color-text-muted) is only 4.15:1 on the dim fill, so
    // the dim state has to override it rather than inherit it.
    const surface = rgb(declaration('.graph-node-card.is-dim', 'background')!);
    const footer = rgb(declaration('.graph-node-card.is-dim .graph-node-card-footer', 'color')!);
    expect(contrastRatio(footer, surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('is still visibly recessed against an undimmed card', () => {
    // A readable dim state that looks identical to a normal one would
    // have traded one problem for another.
    const dim = rgb(declaration('.graph-node-card.is-dim', 'background')!);
    expect(contrastRatio(dim, SURFACE)).toBeGreaterThan(1.05);
  });
});

describe('graph overlay borders carry enough contrast to mean something', () => {
  // WCAG 1.4.11: a boundary that identifies state needs 3:1.
  it('the on-path border clears the non-text minimum', () => {
    const border = rgb(declaration('.graph-node-card.is-on-path', 'border-color')!);
    expect(contrastRatio(border, SURFACE)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    const dim = rgb(declaration('.graph-node-card.is-dim', 'background')!);
    expect(contrastRatio(border, dim)).toBeGreaterThanOrEqual(AA_NON_TEXT);
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
