import {
  translateChapbookExpression,
  renderChapbookExpression,
  renderChapbookAssignment,
} from '../chapbook-macros.js';
import { parseExpression } from '@wanderline/shared';
import type { Expression, Statement } from '../../types.js';

// Variable support (DEV-199), Phase 9: the Chapbook <-> canonical
// expression translation. twee-parser.test.ts covers the end-to-end
// vars-section/[if] recognition; this file pins the lower-level text
// translation itself.

describe('translateChapbookExpression', () => {
  it('leaves a bare identifier untouched — Chapbook has no sigil to strip', () => {
    expect(translateChapbookExpression('gold')).toBe('gold');
  });

  it('translates strict equality/inequality (===/!==) to canonical ==/!=', () => {
    expect(translateChapbookExpression('gold === 5')).toBe('gold == 5');
    expect(translateChapbookExpression('gold !== 5')).toBe('gold != 5');
  });

  it('leaves every other operator untouched — already the canonical symbols', () => {
    expect(translateChapbookExpression('gold > 5')).toBe('gold > 5');
    expect(translateChapbookExpression('gold >= 5')).toBe('gold >= 5');
    expect(translateChapbookExpression('a && b')).toBe('a && b');
    expect(translateChapbookExpression('a || b')).toBe('a || b');
    expect(translateChapbookExpression('!a')).toBe('!a');
    expect(translateChapbookExpression('a + 1')).toBe('a + 1');
  });

  it('does not mistake "===" inside a string literal for the operator', () => {
    expect(translateChapbookExpression('line === "a === b"')).toBe('line == "a === b"');
  });

  it('re-quotes a single-quoted string into the canonical double-quote form', () => {
    expect(translateChapbookExpression("name === 'Andrea'")).toBe('name == "Andrea"');
  });

  it('keeps a literal backslash that is not escaping the quote or itself', () => {
    expect(translateChapbookExpression("'C:\\Users\\x'")).toBe('"C:\\\\Users\\\\x"');
  });

  it('round-trips through parseExpression into the expected AST', () => {
    const ast = parseExpression(translateChapbookExpression('gold > 10 && seen === "yes"'));
    expect(ast).toEqual({
      kind: 'logical',
      operator: '&&',
      left: {
        kind: 'binary',
        operator: '>',
        left: { kind: 'variable', name: 'gold' },
        right: { kind: 'literal', value: 10 },
      },
      right: {
        kind: 'binary',
        operator: '==',
        left: { kind: 'variable', name: 'seen' },
        right: { kind: 'literal', value: 'yes' },
      },
    });
  });
});

describe('renderChapbookExpression', () => {
  const lit = (value: number | string | boolean): Expression => ({ kind: 'literal', value });

  it('renders literals verbatim, re-quoting a string with escaping', () => {
    expect(renderChapbookExpression(lit(5))).toBe('5');
    expect(renderChapbookExpression(lit(true))).toBe('true');
    expect(renderChapbookExpression(lit('hi'))).toBe('"hi"');
    expect(renderChapbookExpression(lit('say "hi"'))).toBe('"say \\"hi\\""');
  });

  it('renders a variable with no sigil at all', () => {
    expect(renderChapbookExpression({ kind: 'variable', name: 'gold' })).toBe('gold');
  });

  it('renders == / != as the strict === / !== form', () => {
    const eq: Expression = {
      kind: 'binary',
      operator: '==',
      left: { kind: 'variable', name: 'gold' },
      right: lit(5),
    };
    expect(renderChapbookExpression(eq)).toBe('(gold === 5)');
    expect(renderChapbookExpression({ ...eq, operator: '!=' })).toBe('(gold !== 5)');
  });

  it('renders other binary/logical operators with their shared symbol, parenthesized', () => {
    const gt: Expression = {
      kind: 'binary',
      operator: '>',
      left: { kind: 'variable', name: 'gold' },
      right: lit(10),
    };
    expect(renderChapbookExpression(gt)).toBe('(gold > 10)');
    const and: Expression = {
      kind: 'logical',
      operator: '&&',
      left: { kind: 'variable', name: 'a' },
      right: { kind: 'variable', name: 'b' },
    };
    expect(renderChapbookExpression(and)).toBe('(a && b)');
  });

  it('round-trips through translateChapbookExpression + parseExpression regardless of nesting', () => {
    const original = parseExpression('(gold > 10 && seen) || (name == "Anna")');
    const cb = renderChapbookExpression(original);
    const reparsed = parseExpression(translateChapbookExpression(cb));
    expect(reparsed).toEqual(original);
  });
});

describe('renderChapbookAssignment', () => {
  it('renders a plain assignment as "name: VALUE"', () => {
    const stmt: Statement = {
      kind: 'assignment',
      name: 'gold',
      operator: '=',
      value: { kind: 'literal', value: 5 },
    };
    expect(renderChapbookAssignment(stmt)).toBe('gold: 5');
  });

  it('expands a compound assignment, since Chapbook has no += shorthand', () => {
    const stmt: Statement = {
      kind: 'assignment',
      name: 'gold',
      operator: '+=',
      value: { kind: 'literal', value: 10 },
    };
    expect(renderChapbookAssignment(stmt)).toBe('gold: gold + 10');
  });
});
