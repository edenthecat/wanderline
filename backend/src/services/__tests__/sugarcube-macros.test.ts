import {
  translateSugarCubeExpression,
  renderSugarCubeExpression,
  renderSugarCubeAssignment,
} from '../sugarcube-macros.js';
import { parseExpression } from '@wanderline/shared';
import type { Expression, Statement } from '../../types.js';

// Variable support (DEV-199), Phase 8: the SugarCube <-> canonical
// expression translation. twee-parser.test.ts covers the end-to-end
// (set:)/(if:) macro recognition; this file pins the lower-level
// text translation itself.

describe('translateSugarCubeExpression', () => {
  it('strips the $ sigil from a variable reference', () => {
    expect(translateSugarCubeExpression('$gold')).toBe('gold');
  });

  it('translates "to" into "=" for <<set>> arguments', () => {
    expect(translateSugarCubeExpression('$gold to 5')).toBe('gold = 5');
  });

  it('leaves raw JS-style operators untouched', () => {
    expect(translateSugarCubeExpression('$gold > 5')).toBe('gold > 5');
    expect(translateSugarCubeExpression('$gold == 5')).toBe('gold == 5');
    expect(translateSugarCubeExpression('$a && $b')).toBe('a && b');
  });

  it('leaves a native compound assignment operator untouched', () => {
    expect(translateSugarCubeExpression('$gold += 10')).toBe('gold += 10');
  });

  it('translates the word-form comparison and logical operator aliases', () => {
    expect(translateSugarCubeExpression('$gold eq 5')).toBe('gold == 5');
    expect(translateSugarCubeExpression('$gold is 5')).toBe('gold == 5');
    expect(translateSugarCubeExpression('$gold neq 5')).toBe('gold != 5');
    expect(translateSugarCubeExpression('$gold isnot 5')).toBe('gold != 5');
    expect(translateSugarCubeExpression('$gold gt 5')).toBe('gold > 5');
    expect(translateSugarCubeExpression('$gold gte 5')).toBe('gold >= 5');
    expect(translateSugarCubeExpression('$gold lt 5')).toBe('gold < 5');
    expect(translateSugarCubeExpression('$gold lte 5')).toBe('gold <= 5');
    expect(translateSugarCubeExpression('$a and $b')).toBe('a && b');
    expect(translateSugarCubeExpression('$a or $b')).toBe('a || b');
    expect(translateSugarCubeExpression('not $a')).toBe('!a');
  });

  it('does not mistake "is"/"and" inside a string literal for operators', () => {
    expect(translateSugarCubeExpression('$line is "this is cool"')).toBe('line == "this is cool"');
    expect(translateSugarCubeExpression('$name is "Andrea"')).toBe('name == "Andrea"');
  });

  it('does NOT strip the sigil off a temp variable (_name) — out of v1 scope', () => {
    expect(translateSugarCubeExpression('_counter')).toBe('_counter');
  });

  it('re-quotes a single-quoted string into the canonical double-quote form', () => {
    expect(translateSugarCubeExpression("$name is 'Andrea'")).toBe('name == "Andrea"');
  });

  it('keeps a literal backslash that is not escaping the quote or itself', () => {
    expect(translateSugarCubeExpression("'C:\\Users\\x'")).toBe('"C:\\\\Users\\\\x"');
  });

  it('round-trips through parseExpression into the expected AST', () => {
    const ast = parseExpression(translateSugarCubeExpression('$gold gt 10 and $seen is "yes"'));
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

describe('renderSugarCubeExpression', () => {
  const lit = (value: number | string | boolean): Expression => ({ kind: 'literal', value });

  it('renders literals verbatim, re-quoting a string with escaping', () => {
    expect(renderSugarCubeExpression(lit(5))).toBe('5');
    expect(renderSugarCubeExpression(lit(true))).toBe('true');
    expect(renderSugarCubeExpression(lit('hi'))).toBe('"hi"');
    expect(renderSugarCubeExpression(lit('say "hi"'))).toBe('"say \\"hi\\""');
  });

  it('never prefixes a boolean literal with a $ sigil (only variable nodes get one)', () => {
    expect(renderSugarCubeExpression(lit(true))).not.toContain('$');
    expect(renderSugarCubeExpression({ kind: 'variable', name: 'true' })).toBe('$true');
  });

  it('renders a variable with the $ sigil', () => {
    expect(renderSugarCubeExpression({ kind: 'variable', name: 'gold' })).toBe('$gold');
  });

  it('renders operators with their raw symbol, parenthesized — no word-form translation needed', () => {
    const eq: Expression = {
      kind: 'binary',
      operator: '==',
      left: { kind: 'variable', name: 'gold' },
      right: lit(5),
    };
    expect(renderSugarCubeExpression(eq)).toBe('($gold == 5)');
    const and: Expression = {
      kind: 'logical',
      operator: '&&',
      left: { kind: 'variable', name: 'a' },
      right: { kind: 'variable', name: 'b' },
    };
    expect(renderSugarCubeExpression(and)).toBe('($a && $b)');
  });

  it('renders unary ! and - with no word-form translation', () => {
    expect(
      renderSugarCubeExpression({
        kind: 'unary',
        operator: '!',
        operand: { kind: 'variable', name: 'a' },
      }),
    ).toBe('!$a');
  });

  it('round-trips through translateSugarCubeExpression + parseExpression regardless of nesting', () => {
    const original = parseExpression('(gold > 10 && seen) || (name == "Anna")');
    const sc = renderSugarCubeExpression(original);
    const reparsed = parseExpression(translateSugarCubeExpression(sc));
    expect(reparsed).toEqual(original);
  });
});

describe('renderSugarCubeAssignment', () => {
  it('renders a plain assignment as <<set $name = VALUE>>', () => {
    const stmt: Statement = {
      kind: 'assignment',
      name: 'gold',
      operator: '=',
      value: { kind: 'literal', value: 5 },
    };
    expect(renderSugarCubeAssignment(stmt)).toBe('<<set $gold = 5>>');
  });

  it('renders a compound assignment natively — no expansion needed, unlike Harlowe', () => {
    const stmt: Statement = {
      kind: 'assignment',
      name: 'gold',
      operator: '+=',
      value: { kind: 'literal', value: 10 },
    };
    expect(renderSugarCubeAssignment(stmt)).toBe('<<set $gold += 10>>');
  });
});
