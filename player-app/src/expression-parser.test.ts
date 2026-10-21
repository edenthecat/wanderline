import { describe, it, expect } from 'vitest';
import {
  parseExpression,
  parseStatement,
  printExpression,
  printStatement,
  ExpressionParseError,
  evaluate,
  type Expression,
} from '@wanderline/shared';

// Variable support (DEV-199), Phase 0: parser/printer for the
// canonical textual surface (Ink's own expression grammar — see
// expression-parser.ts's header for why). The round-trip property —
// parse(print(parse(source))) is equivalent to parse(source) — is
// what later phases rely on: Ink's parser feeds this module raw
// expression substrings directly, and the editor's condition-editing
// UI (Phase 5) both parses what an author types and prints what it
// loaded back for editing.

function roundTrip(source: string): void {
  const ast = parseExpression(source);
  const printed = printExpression(ast);
  const reparsed = parseExpression(printed);
  expect(reparsed).toEqual(ast);
}

describe('parseExpression — primaries', () => {
  it('numbers, strings, booleans, and variables', () => {
    expect(parseExpression('5')).toEqual({ kind: 'literal', value: 5 });
    expect(parseExpression('3.5')).toEqual({ kind: 'literal', value: 3.5 });
    expect(parseExpression('"hello"')).toEqual({ kind: 'literal', value: 'hello' });
    expect(parseExpression('true')).toEqual({ kind: 'literal', value: true });
    expect(parseExpression('false')).toEqual({ kind: 'literal', value: false });
    expect(parseExpression('gold')).toEqual({ kind: 'variable', name: 'gold' });
  });

  it('a string literal with an escaped quote', () => {
    expect(parseExpression('"say \\"hi\\""')).toEqual({ kind: 'literal', value: 'say "hi"' });
  });

  it('parenthesized expression', () => {
    expect(parseExpression('(5)')).toEqual({ kind: 'literal', value: 5 });
  });
});

describe('parseExpression — operator precedence', () => {
  it('* binds tighter than +', () => {
    const ast = parseExpression('2 + 3 * 4') as Expression & { kind: 'binary' };
    expect(ast.operator).toBe('+');
    expect((ast.right as Expression & { kind: 'binary' }).operator).toBe('*');
    expect(evaluate(ast, {})).toBe(14);
  });

  it('comparison binds looser than arithmetic', () => {
    expect(evaluate(parseExpression('1 + 1 == 2'), {})).toBe(true);
  });

  it('&& binds tighter than ||', () => {
    // Without correct precedence this would be (true || true) && false = false.
    expect(evaluate(parseExpression('false || true && false'), {})).toBe(false);
  });

  it('parentheses override default precedence', () => {
    expect(evaluate(parseExpression('(2 + 3) * 4'), {})).toBe(20);
  });

  it('unary binds tighter than binary', () => {
    expect(evaluate(parseExpression('-2 + 5'), {})).toBe(3);
    expect(evaluate(parseExpression('!true || true'), {})).toBe(true);
  });

  it('left-associativity for non-associative operators', () => {
    // 10 - 3 - 2 must parse as (10 - 3) - 2 = 5, not 10 - (3 - 2) = 9.
    expect(evaluate(parseExpression('10 - 3 - 2'), {})).toBe(5);
    expect(evaluate(parseExpression('20 / 2 / 5'), {})).toBe(2);
  });
});

describe('parseExpression — error cases', () => {
  it('rejects unterminated strings', () => {
    expect(() => parseExpression('"unterminated')).toThrow(ExpressionParseError);
  });

  it('rejects unexpected trailing input', () => {
    expect(() => parseExpression('5 5')).toThrow(ExpressionParseError);
  });

  it('rejects an unmatched closing paren', () => {
    expect(() => parseExpression('(5')).toThrow(ExpressionParseError);
  });

  it('rejects an unknown character', () => {
    expect(() => parseExpression('5 & 3')).toThrow(ExpressionParseError);
  });
});

describe('parseStatement', () => {
  it('plain assignment', () => {
    expect(parseStatement('x = 5')).toEqual({
      kind: 'assignment',
      name: 'x',
      operator: '=',
      value: { kind: 'literal', value: 5 },
    });
  });

  it.each(['+=', '-=', '*=', '/='] as const)('compound assignment %s', (operator) => {
    expect(parseStatement(`gold ${operator} 10`)).toEqual({
      kind: 'assignment',
      name: 'gold',
      operator,
      value: { kind: 'literal', value: 10 },
    });
  });

  it('the right-hand side can be an arbitrary expression', () => {
    expect(parseStatement('total = a + b * 2')).toEqual({
      kind: 'assignment',
      name: 'total',
      operator: '=',
      value: {
        kind: 'binary',
        operator: '+',
        left: { kind: 'variable', name: 'a' },
        right: {
          kind: 'binary',
          operator: '*',
          left: { kind: 'variable', name: 'b' },
          right: { kind: 'literal', value: 2 },
        },
      },
    });
  });

  it('rejects a statement with no assignment operator', () => {
    expect(() => parseStatement('x + 1')).toThrow(ExpressionParseError);
  });
});

describe('round-trip: parse -> print -> re-parse', () => {
  it.each([
    '5',
    '"hello world"',
    'true',
    'gold',
    '2 + 3 * 4',
    '(2 + 3) * 4',
    '10 - 3 - 2',
    '20 / (2 / 5)',
    '-x + 5',
    '!seen_market && gold > 10',
    'a == b || c != d',
    'a < b && b < c',
    '-(-x)',
    '"a" + "b" + "c"',
  ])('%s', (source) => {
    roundTrip(source);
  });

  it('printed output reflects the correct precedence (no over- or under-parenthesizing)', () => {
    // 2 + 3 * 4 should NOT print as "2 + (3 * 4)" — the paren is
    // unnecessary since * already binds tighter.
    expect(printExpression(parseExpression('2 + 3 * 4'))).toBe('2 + 3 * 4');
    // (2 + 3) * 4 — the paren here IS necessary, since without it
    // the expression would mean something else.
    expect(printExpression(parseExpression('(2 + 3) * 4'))).toBe('(2 + 3) * 4');
    // 10 - 3 - 2 is left-associative and needs no parens at all.
    expect(printExpression(parseExpression('10 - 3 - 2'))).toBe('10 - 3 - 2');
    // 10 - (3 - 2) must keep its parens on re-print, or it would
    // silently change meaning (reprinting as "10 - 3 - 2" = 5, not 9).
    expect(printExpression(parseExpression('10 - (3 - 2)'))).toBe('10 - (3 - 2)');
  });

  it.each(['x = 5', 'gold += 10', 'total = a + b * 2'])('%s', (source) => {
    const ast = parseStatement(source);
    const printed = printStatement(ast);
    expect(parseStatement(printed)).toEqual(ast);
  });
});
