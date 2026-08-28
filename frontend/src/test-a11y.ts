// Shared axe-core harness for the editor's component tests.
//
// `jest-axe`'s `axe()` is the useful part of the package: it mounts the
// fragment into the document, waits for axe to settle, and disables
// axe's colour rules — see `configureAxe` in jest-axe/index.js, which
// switches off every rule tagged `cat.color` and nothing else. The
// assertion is ours because `toHaveNoViolations` is typed against
// Jest's matcher interface and this workspace runs vitest.
//
// What this catches: names on controls and images, ARIA attributes
// that don't belong on their role, required parent/child role
// relationships, aria-hidden wrapped around something focusable,
// aria-* pointing at ids that aren't in the document, duplicate ids,
// heading order.
//
// What it does not:
//  - Colour contrast — at all. jsdom does no layout or painting, so
//    axe can't resolve computed colours, and jest-axe turns the whole
//    `cat.color` category off rather than let it produce noise. The
//    rule never runs here; the FontPicker's 1.041:1 highlight would
//    have passed this suite untouched. Contrast needs a real browser
//    or a person.
//  - Anything that only exists over time: whether
//    `aria-activedescendant` follows the row the user arrowed to,
//    whether a live region ever actually announces, where focus lands
//    when a control deletes itself. axe reads one static tree.
// Those are covered by the hand-written tests alongside these.

import { axe } from 'jest-axe';
import { expect } from 'vitest';
import type { AxeResults } from 'axe-core';

function describeViolations(results: AxeResults): string {
  return results.violations
    .map((v) => {
      const where = v.nodes.map((n) => `      ${n.html}`).join('\n');
      return `  [${v.impact ?? 'unknown'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${where}`;
    })
    .join('\n\n');
}

/**
 * Run axe over a rendered container and fail with the rule ids, the
 * offending markup, and a link to the rule description.
 */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe(container);
  if (results.violations.length > 0) {
    throw new Error(
      `Expected no accessibility violations, found ${results.violations.length}:\n\n` +
        describeViolations(results),
    );
  }
  expect(results.violations).toHaveLength(0);
}
