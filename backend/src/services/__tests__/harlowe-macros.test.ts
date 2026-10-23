import {
  translateHarloweExpression,
  renderHarloweExpression,
  renderHarloweAssignment,
} from '../harlowe-macros.js';
import { parseExpression } from '@wanderline/shared';
import type { Expression, Statement } from '../../types.js';

// Variable support (DEV-199), Phase 7: the Harlowe <-> canonical
// expression translation. twee-parser.test.ts covers the end-to-end
// (set:)/(if:) macro recognition; this file pins the lower-level
// text translation itself, since a subtle bug here (e.g. mangling a
// string literal that happens to contain the word "and") would be
// easy to miss from the integration tests alone.

describe('translateHarloweExpression', () => {
  it('strips the $ sigil from a variable reference', () => {
    expect(translateHarloweExpression('$gold')).toBe('gold');
  });

  it('translates word-form comparison and logical operators', () => {
    expect(translateHarloweExpression('$gold is 5')).toBe('gold == 5');
    expect(translateHarloweExpression('$gold is not 5')).toBe('gold != 5');
    expect(translateHarloweExpression('$a and $b')).toBe('a && b');
    expect(translateHarloweExpression('$a or $b')).toBe('a || b');
    expect(translateHarloweExpression('not $a')).toBe('!a');
  });

  it('matches "is not" before the bare "is" rule could split it wrong', () => {
    expect(translateHarloweExpression('$x is not $y')).toBe('x != y');
  });

  it('re-quotes a single-quoted string into the canonical double-quote form', () => {
    expect(translateHarloweExpression("$name is 'Andrea'")).toBe('name == "Andrea"');
  });

  it('does not mistake "and"/"is" inside a string literal for operators', () => {
    // The whole point of tokenizing rather than regexing the raw
    // source: "Andrea" contains "and", and a sentence can contain
    // "is" as an ordinary word, neither of which are operators here.
    expect(translateHarloweExpression('$name is "Andrea"')).toBe('name == "Andrea"');
    expect(translateHarloweExpression('$line is "this is cool"')).toBe('line == "this is cool"');
  });

  it('keeps a literal backslash that is not escaping the quote or itself (e.g. a Windows path)', () => {
    // Regression: the unescape loop used to treat ANY backslash as an
    // escape sequence (dropping it, keeping only the next char),
    // silently merging "Users" and "x" together and losing both
    // backslashes from a path like 'C:\Users\x'.
    expect(translateHarloweExpression("'C:\\Users\\x'")).toBe('"C:\\\\Users\\\\x"');
  });

  it('unescapes relative to the original quote, then re-escapes for double quotes', () => {
    // A single-quoted string with an escaped single quote inside
    // means a literal apostrophe — re-quoting it in double quotes
    // needs no escaping at all for that character.
    expect(translateHarloweExpression("$x is 'it\\'s fine'")).toBe('x == "it\'s fine"');
    // A double-quoted string with an escaped double quote inside
    // needs that quote re-escaped when re-wrapped in double quotes.
    expect(translateHarloweExpression('$x is "she said \\"hi\\""')).toBe(
      'x == "she said \\"hi\\""',
    );
  });

  it('round-trips through parseExpression into the expected AST', () => {
    const ast = parseExpression(translateHarloweExpression('$gold > 10 and $seen is "yes"'));
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

describe('renderHarloweExpression', () => {
  const lit = (value: number | string | boolean): Expression => ({ kind: 'literal', value });

  it('renders literals verbatim, re-quoting a string with escaping', () => {
    expect(renderHarloweExpression(lit(5))).toBe('5');
    expect(renderHarloweExpression(lit(true))).toBe('true');
    expect(renderHarloweExpression(lit('hi'))).toBe('"hi"');
    expect(renderHarloweExpression(lit('say "hi"'))).toBe('"say \\"hi\\""');
  });

  it('never prefixes a boolean literal with a $ sigil (only variable nodes get one)', () => {
    expect(renderHarloweExpression(lit(true))).not.toContain('$');
    expect(renderHarloweExpression({ kind: 'variable', name: 'true' })).toBe('$true');
  });

  it('renders a variable with the $ sigil', () => {
    expect(renderHarloweExpression({ kind: 'variable', name: 'gold' })).toBe('$gold');
  });

  it('renders == / != as word-form "is" / "is not"', () => {
    const eq: Expression = {
      kind: 'binary',
      operator: '==',
      left: { kind: 'variable', name: 'gold' },
      right: lit(5),
    };
    expect(renderHarloweExpression(eq)).toBe('($gold) is (5)');
    const neq: Expression = { ...eq, operator: '!=' };
    expect(renderHarloweExpression(neq)).toBe('($gold) is not (5)');
  });

  it('renders other binary operators with their shared symbol, parenthesized', () => {
    const gt: Expression = {
      kind: 'binary',
      operator: '>',
      left: { kind: 'variable', name: 'gold' },
      right: lit(10),
    };
    expect(renderHarloweExpression(gt)).toBe('($gold) > (10)');
  });

  it('renders && / || as word-form "and" / "or"', () => {
    const and: Expression = {
      kind: 'logical',
      operator: '&&',
      left: { kind: 'variable', name: 'a' },
      right: { kind: 'variable', name: 'b' },
    };
    expect(renderHarloweExpression(and)).toBe('($a) and ($b)');
    expect(renderHarloweExpression({ ...and, operator: '||' })).toBe('($a) or ($b)');
  });

  it('renders unary ! as word-form "not"', () => {
    expect(
      renderHarloweExpression({
        kind: 'unary',
        operator: '!',
        operand: { kind: 'variable', name: 'a' },
      }),
    ).toBe('not ($a)');
  });

  it('round-trips through translateHarloweExpression + parseExpression regardless of nesting', () => {
    const original = parseExpression('(gold > 10 && seen) || (name == "Anna")');
    const harlowe = renderHarloweExpression(original);
    const reparsed = parseExpression(translateHarloweExpression(harlowe));
    expect(reparsed).toEqual(original);
  });
});

describe('renderHarloweAssignment', () => {
  it('renders a plain assignment as (set: $name to VALUE)', () => {
    const stmt: Statement = {
      kind: 'assignment',
      name: 'gold',
      operator: '=',
      value: { kind: 'literal', value: 5 },
    };
    expect(renderHarloweAssignment(stmt)).toBe('(set: $gold to 5)');
  });

  it('expands a compound assignment, since (set:) has no += shorthand', () => {
    const stmt: Statement = {
      kind: 'assignment',
      name: 'gold',
      operator: '+=',
      value: { kind: 'literal', value: 10 },
    };
    expect(renderHarloweAssignment(stmt)).toBe('(set: $gold to ($gold) + (10))');
  });
});
