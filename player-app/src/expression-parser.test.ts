import { describe, it, expect } from 'vitest';
import {
  parseExpression,
  parseStatement,
  printExpression,
  printStatement,
  ExpressionParseError,
  evaluate,
  type Expression,
  type ExpressionParseContext,
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
    'a + (b + c)',
    'a * (b * c)',
    'a == (b == c)',
    'a && (b && c)',
    'a || (b || c)',
    'a < (b < c)',
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
    // Every tier parses strictly left-associatively, so a right-nested
    // same-precedence child — even for operators where the regrouping
    // happens to be value-preserving, like + or && — only exists in
    // the AST because the source had explicit parens there. Losing
    // them on reprint changes which AST the string parses back into,
    // even when it doesn't change the evaluated value.
    expect(printExpression(parseExpression('a + (b + c)'))).toBe('a + (b + c)');
    expect(printExpression(parseExpression('a && (b && c)'))).toBe('a && (b && c)');
  });

  it.each(['x = 5', 'gold += 10', 'total = a + b * 2'])('%s', (source) => {
    const ast = parseStatement(source);
    const printed = printStatement(ast);
    expect(parseStatement(printed)).toEqual(ast);
  });
});

// DEV-199 Phase 10: Ink's LIST type and the fixed LIST_* query
// functions. `cold`/`boiling`/`recently_boiled` is kettleState's
// declared member order throughout — ordinals below always match
// that declaration, as a real LIST kettleState = cold, (boiling),
// recently_boiled would produce.
const KETTLE_ALL = [
  { name: 'cold', ordinal: 0 },
  { name: 'boiling', ordinal: 1 },
  { name: 'recently_boiled', ordinal: 2 },
];
const KETTLE_CONTEXT: ExpressionParseContext = {
  listMembers: Object.fromEntries(
    KETTLE_ALL.map((item) => [item.name, { origin: 'kettleState', ordinal: item.ordinal }]),
  ),
  listDefinitions: { kettleState: KETTLE_ALL },
};

function roundTripList(source: string): void {
  const ast = parseExpression(source, KETTLE_CONTEXT);
  const printed = printExpression(ast);
  const reparsed = parseExpression(printed, KETTLE_CONTEXT);
  expect(reparsed).toEqual(ast);
}

// A second, independent LIST alongside kettleState, for testing that
// a multi-member list literal can't mix members from two different
// LISTs (each has its own origin/ordinal space).
const BATH_ALL = [
  { name: 'empty', ordinal: 0 },
  { name: 'full', ordinal: 1 },
];
const TWO_LIST_CONTEXT: ExpressionParseContext = {
  listMembers: {
    ...KETTLE_CONTEXT.listMembers,
    ...Object.fromEntries(
      BATH_ALL.map((item) => [item.name, { origin: 'bathState', ordinal: item.ordinal }]),
    ),
  },
  listDefinitions: { ...KETTLE_CONTEXT.listDefinitions, bathState: BATH_ALL },
};

describe('parseExpression — LIST literals', () => {
  it('a bare member name is a single-item LIST literal, not a variable', () => {
    expect(parseExpression('cold', KETTLE_CONTEXT)).toEqual({
      kind: 'literal',
      value: {
        kind: 'list',
        origin: 'kettleState',
        items: [{ name: 'cold', ordinal: 0 }],
        allItems: KETTLE_ALL,
      },
    });
  });

  it('an identifier NOT in context stays a plain variable reference', () => {
    expect(parseExpression('cold')).toEqual({ kind: 'variable', name: 'cold' });
    expect(parseExpression('gold', KETTLE_CONTEXT)).toEqual({ kind: 'variable', name: 'gold' });
  });

  it('__proto__ stays a plain variable reference when it has no OWN entry in context.listMembers (found in review)', () => {
    // `context.listMembers` is a plain Record, and an unguarded
    // `obj['__proto__']` read inherits Object.prototype (truthy)
    // instead of returning undefined for a key with no own entry —
    // which would make `__proto__` look like a registered list
    // member with a bogus origin, even though no LIST ever declared
    // one.
    expect(parseExpression('__proto__', KETTLE_CONTEXT)).toEqual({
      kind: 'variable',
      name: '__proto__',
    });
    // Omitting `context` entirely never exercised the bug (the
    // Parser defaults it to `{}`, leaving `listMembers` itself
    // `undefined`) — an explicit, populated-but-empty `listMembers`
    // is what actually reproduces it.
    expect(parseExpression('__proto__ > 0', { listMembers: {} })).toEqual({
      kind: 'binary',
      operator: '>',
      left: { kind: 'variable', name: '__proto__' },
      right: { kind: 'literal', value: 0 },
    });
  });

  it('a parenthesized comma list of members is a multi-item LIST literal', () => {
    expect(parseExpression('(cold, boiling)', KETTLE_CONTEXT)).toEqual({
      kind: 'literal',
      value: {
        kind: 'list',
        origin: 'kettleState',
        items: [
          { name: 'cold', ordinal: 0 },
          { name: 'boiling', ordinal: 1 },
        ],
        allItems: KETTLE_ALL,
      },
    });
  });

  it('() is an empty LIST literal', () => {
    expect(parseExpression('()', KETTLE_CONTEXT)).toEqual({
      kind: 'literal',
      value: { kind: 'list', origin: '', items: [], allItems: [] },
    });
  });

  it('a plain parenthesized sub-expression still parses as grouping, not a list', () => {
    expect(parseExpression('(5)', KETTLE_CONTEXT)).toEqual({ kind: 'literal', value: 5 });
    expect(parseExpression('(gold + 1)', KETTLE_CONTEXT)).toEqual({
      kind: 'binary',
      operator: '+',
      left: { kind: 'variable', name: 'gold' },
      right: { kind: 'literal', value: 1 },
    });
  });

  it.each(['cold', '(cold, boiling)', '()'])('round-trips %s', (source) => {
    roundTripList(source);
  });

  it('rejects a list literal mixing members from two different LISTs', () => {
    expect(() => parseExpression('(cold, full)', TWO_LIST_CONTEXT)).toThrow(
      /mixes members from different LISTs/,
    );
  });
});

describe('parseExpression — LIST operators', () => {
  it('+= and -= style union/difference', () => {
    expect(parseExpression('kettleState + cold', KETTLE_CONTEXT)).toMatchObject({
      kind: 'binary',
      operator: '+',
    });
    roundTripList('kettleState - cold');
  });

  it('? and has both canonicalize to the "has" operator', () => {
    const viaSymbol = parseExpression('kettleState ? cold', KETTLE_CONTEXT);
    const viaWord = parseExpression('kettleState has cold', KETTLE_CONTEXT);
    expect(viaSymbol).toEqual(viaWord);
    expect(viaSymbol).toMatchObject({ kind: 'binary', operator: 'has' });
  });

  it('!? and hasnt both canonicalize to the "hasnt" operator', () => {
    const viaSymbol = parseExpression('kettleState !? cold', KETTLE_CONTEXT);
    const viaWord = parseExpression('kettleState hasnt cold', KETTLE_CONTEXT);
    expect(viaSymbol).toEqual(viaWord);
    expect(viaSymbol).toMatchObject({ kind: 'binary', operator: 'hasnt' });
  });

  it('positional comparison operators parse at the same tier as ==', () => {
    expect(parseExpression('kettleState < boiling', KETTLE_CONTEXT)).toMatchObject({
      kind: 'binary',
      operator: '<',
    });
  });

  it.each(['kettleState ? cold', 'kettleState has cold', 'kettleState hasnt boiling'])(
    'round-trips %s to its canonical word form',
    (source) => {
      const ast = parseExpression(source, KETTLE_CONTEXT);
      const printed = printExpression(ast);
      expect(parseExpression(printed, KETTLE_CONTEXT)).toEqual(ast);
    },
  );
});

describe('parseExpression — LIST_* query functions', () => {
  it('parses a recognized LIST_* call with its arguments', () => {
    expect(parseExpression('LIST_COUNT(kettleState)', KETTLE_CONTEXT)).toEqual({
      kind: 'listFunction',
      name: 'LIST_COUNT',
      args: [{ kind: 'variable', name: 'kettleState' }],
    });
  });

  it('parses a multi-argument call (LIST_RANGE)', () => {
    const ast = parseExpression('LIST_RANGE(kettleState, 1, 2)', KETTLE_CONTEXT);
    expect(ast).toEqual({
      kind: 'listFunction',
      name: 'LIST_RANGE',
      args: [
        { kind: 'variable', name: 'kettleState' },
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: 2 },
      ],
    });
  });

  it('rejects a call to an unrecognized function name', () => {
    expect(() => parseExpression('myCustomFunc(1)')).toThrow(ExpressionParseError);
  });

  it.each(['LIST_COUNT(kettleState)', 'LIST_RANGE(kettleState, 1, 2)'])(
    'round-trips %s',
    (source) => {
      roundTripList(source);
    },
  );
});

// Function-knot calls (DEV-199 Phase 10b): `name(args)` parses as a
// `call` expression only when `name` is in `context.knownFunctions`
// — the set of declared `=== function ===` knots, collected by the
// caller (ink-parser.ts in practice). Still rejected, same as before
// this phase, for any other bare name.
describe('parseExpression — function-knot calls', () => {
  const FUNCS: ExpressionParseContext = { knownFunctions: new Set(['double', 'add']) };

  it('parses a call to a known function-knot with its arguments', () => {
    expect(parseExpression('double(5)', FUNCS)).toEqual({
      kind: 'call',
      name: 'double',
      args: [{ kind: 'literal', value: 5 }],
    });
  });

  it('parses a multi-argument call', () => {
    expect(parseExpression('add(x, 2)', FUNCS)).toEqual({
      kind: 'call',
      name: 'add',
      args: [
        { kind: 'variable', name: 'x' },
        { kind: 'literal', value: 2 },
      ],
    });
  });

  it('parses nested calls', () => {
    expect(parseExpression('double(add(1, 2))', FUNCS)).toEqual({
      kind: 'call',
      name: 'double',
      args: [
        {
          kind: 'call',
          name: 'add',
          args: [
            { kind: 'literal', value: 1 },
            { kind: 'literal', value: 2 },
          ],
        },
      ],
    });
  });

  it('parses a call inside a larger expression', () => {
    const ast = parseExpression('double(5) > 8', FUNCS);
    expect(ast).toEqual({
      kind: 'binary',
      operator: '>',
      left: { kind: 'call', name: 'double', args: [{ kind: 'literal', value: 5 }] },
      right: { kind: 'literal', value: 8 },
    });
  });

  it('rejects a call to a name not in knownFunctions', () => {
    expect(() => parseExpression('double(5)')).toThrow(ExpressionParseError);
    expect(() => parseExpression('notDeclared(5)', FUNCS)).toThrow(ExpressionParseError);
  });

  it('a LIST_* builtin still wins over a same-named knownFunctions entry', () => {
    const ctx: ExpressionParseContext = { knownFunctions: new Set(['LIST_COUNT']) };
    expect(parseExpression('LIST_COUNT(5)', ctx).kind).toBe('listFunction');
  });

  it.each(['double(5)', 'add(x, 2)', 'double(add(1, 2))'])('round-trips %s', (source) => {
    const ast = parseExpression(source, FUNCS);
    const printed = printExpression(ast);
    expect(parseExpression(printed, FUNCS)).toEqual(ast);
  });
});

// `~ return EXPR` / bare `~ return` (DEV-199 Phase 10b): a second
// Statement kind alongside assignment.
describe('parseStatement — return', () => {
  it('parses a bare return with no value', () => {
    expect(parseStatement('return')).toEqual({ kind: 'return' });
  });

  it('parses a return with a value expression', () => {
    expect(parseStatement('return x * 2')).toEqual({
      kind: 'return',
      value: {
        kind: 'binary',
        operator: '*',
        left: { kind: 'variable', name: 'x' },
        right: { kind: 'literal', value: 2 },
      },
    });
  });

  it('parses a return of a function call', () => {
    const ctx: ExpressionParseContext = { knownFunctions: new Set(['helper']) };
    expect(parseStatement('return helper(x)', ctx)).toEqual({
      kind: 'return',
      value: { kind: 'call', name: 'helper', args: [{ kind: 'variable', name: 'x' }] },
    });
  });

  it('round-trips a bare return', () => {
    const ast = parseStatement('return');
    expect(parseStatement(printStatement(ast))).toEqual(ast);
  });

  it('round-trips a return with a value', () => {
    const ast = parseStatement('return x + 1');
    expect(parseStatement(printStatement(ast))).toEqual(ast);
  });

  it('still parses an ordinary assignment unaffected by the return grammar', () => {
    expect(parseStatement('gold = gold + 10')).toEqual({
      kind: 'assignment',
      name: 'gold',
      operator: '=',
      value: {
        kind: 'binary',
        operator: '+',
        left: { kind: 'variable', name: 'gold' },
        right: { kind: 'literal', value: 10 },
      },
    });
  });
});
