import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The command palette moves focus to .workspace-main programmatically
// when it closes and the control that opened it is gone (most often a
// Graph jump, where the ReactFlow canvas takes the node focus rather
// than a keyboard-focusable control) — so this ring is the only visual
// anchor a keyboard user gets that focus went anywhere at all.
//
// A structural check on the stylesheet rather than a rendered-DOM
// check: jsdom doesn't implement the browser's :focus-visible
// heuristic (whether a given focus() call should be considered
// "visible-worthy"), so asserting on computed styles after a
// programmatic .focus() call wouldn't exercise the actual rule this
// is guarding.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}[^{]*\\{([^}]*)\\}`).exec(css);
  expect(match, `expected a rule for ${selector}`).not.toBeNull();
  return match![1];
}

describe('the workspace region has a real focus indicator', () => {
  it('does not suppress the focus-visible outline with none', () => {
    const decl = rule('.workspace-main:focus-visible');
    expect(decl).not.toMatch(/outline\s*:\s*none\b/);
    expect(decl).toMatch(/outline\s*:\s*2px solid/);
  });

  // The bare :focus selector (fires on every focus, not just the ones
  // the browser considers visible-worthy) is not styled at all here.
  // That's deliberate: if it forced outline:none the way the combined
  // rule used to, a browser whose :focus-visible heuristic doesn't
  // treat this particular focus() call as visible-worthy would fall
  // back to fully invisible instead of the browser's own native ring.
  it('does not also force outline:none on the bare :focus selector', () => {
    // No rule at all for the bare selector — if one existed setting
    // outline:none, that alone would defeat the fix regardless of what
    // :focus-visible says, for any browser whose heuristic disagrees
    // with Chrome's about this particular programmatic focus() call.
    const match = /(?:^|\n)\.workspace-main:focus[^-][^{]*\{([^}]*)\}/.exec(css);
    if (match) {
      expect(match[1]).not.toMatch(/outline\s*:\s*none\b/);
    }
  });
});
