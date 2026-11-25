import { describe, it, expect } from 'vitest';
import {
  evaluate,
  evaluateWithEffects,
  execute,
  truthy,
  isListValue,
  expressionUsesListFeatures,
  expressionUsesFunctionCalls,
  ExpressionEvaluationError,
  type CallFunctionHandler,
  type Expression,
  type AssignmentStatement,
  type ListValue,
} from '@wanderline/shared';

// Variable support (DEV-199), Phase 0: the pure evaluator both the
// backend (validation/preview) and this player import — these tests
// are the one place its arithmetic/comparison/logical semantics are
// pinned, since the player's own runtime behavior for conditional
// text/choices (later phases) is only as correct as this file.

function lit(value: number | string | boolean): Expression {
  return { kind: 'literal', value };
}
function v(name: string): Expression {
  return { kind: 'variable', name };
}

describe('evaluate — literals and variables', () => {
  it('returns a literal value as-is', () => {
    expect(evaluate(lit(5), {})).toBe(5);
    expect(evaluate(lit('hi'), {})).toBe('hi');
    expect(evaluate(lit(true), {})).toBe(true);
  });

  it('looks up a variable by name', () => {
    expect(evaluate(v('gold'), { gold: 10 })).toBe(10);
  });

  it('throws on an undefined variable, rather than returning undefined', () => {
    expect(() => evaluate(v('missing'), {})).toThrow(ExpressionEvaluationError);
  });
});

describe('evaluate — arithmetic', () => {
  it.each([
    ['+', 2, 3, 5],
    ['-', 5, 3, 2],
    ['*', 4, 3, 12],
    ['/', 10, 4, 2.5],
    ['%', 10, 3, 1],
  ] as const)('%s', (operator, left, right, expected) => {
    const expr: Expression = { kind: 'binary', operator, left: lit(left), right: lit(right) };
    expect(evaluate(expr, {})).toBe(expected);
  });

  it('+ concatenates when either side is a string', () => {
    expect(
      evaluate({ kind: 'binary', operator: '+', left: lit('score: '), right: lit(5) }, {}),
    ).toBe('score: 5');
    expect(
      evaluate({ kind: 'binary', operator: '+', left: lit(5), right: lit(' points') }, {}),
    ).toBe('5 points');
  });

  it('rejects arithmetic (other than +) on non-numbers', () => {
    const expr: Expression = { kind: 'binary', operator: '-', left: lit('a'), right: lit(1) };
    expect(() => evaluate(expr, {})).toThrow(ExpressionEvaluationError);
  });

  it('division and modulo by zero throw rather than returning Infinity/NaN', () => {
    expect(() =>
      evaluate({ kind: 'binary', operator: '/', left: lit(1), right: lit(0) }, {}),
    ).toThrow(/division by zero/i);
    expect(() =>
      evaluate({ kind: 'binary', operator: '%', left: lit(1), right: lit(0) }, {}),
    ).toThrow(/modulo by zero/i);
  });
});

describe('evaluate — comparisons', () => {
  it.each([
    ['==', 5, 5, true],
    ['!=', 5, 5, false],
    ['<', 3, 5, true],
    ['<=', 5, 5, true],
    ['>', 5, 3, true],
    ['>=', 3, 5, false],
  ] as const)('%s', (operator, left, right, expected) => {
    const expr: Expression = { kind: 'binary', operator, left: lit(left), right: lit(right) };
    expect(evaluate(expr, {})).toBe(expected);
  });

  it('== and != work across types without throwing (just never equal)', () => {
    expect(evaluate({ kind: 'binary', operator: '==', left: lit(5), right: lit('5') }, {})).toBe(
      false,
    );
  });

  it('< <= > >= reject mismatched or non-comparable types', () => {
    const expr: Expression = { kind: 'binary', operator: '<', left: lit(true), right: lit(5) };
    expect(() => evaluate(expr, {})).toThrow(ExpressionEvaluationError);
  });

  it('string comparison uses lexicographic order', () => {
    expect(evaluate({ kind: 'binary', operator: '<', left: lit('a'), right: lit('b') }, {})).toBe(
      true,
    );
  });
});

describe('evaluate — logical operators and truthiness', () => {
  it('&& and || on booleans', () => {
    expect(
      evaluate({ kind: 'logical', operator: '&&', left: lit(true), right: lit(false) }, {}),
    ).toBe(false);
    expect(
      evaluate({ kind: 'logical', operator: '||', left: lit(true), right: lit(false) }, {}),
    ).toBe(true);
  });

  it('short-circuits && without evaluating the right side', () => {
    // An undefined-variable reference on the right would throw if
    // evaluated — short-circuiting must skip it entirely.
    const expr: Expression = {
      kind: 'logical',
      operator: '&&',
      left: lit(false),
      right: v('nope'),
    };
    expect(evaluate(expr, {})).toBe(false);
  });

  it('short-circuits || without evaluating the right side', () => {
    const expr: Expression = { kind: 'logical', operator: '||', left: lit(true), right: v('nope') };
    expect(evaluate(expr, {})).toBe(true);
  });

  it('truthiness: 0 and empty string are falsy, everything else truthy', () => {
    expect(evaluate({ kind: 'unary', operator: '!', operand: lit(0) }, {})).toBe(true);
    expect(evaluate({ kind: 'unary', operator: '!', operand: lit('') }, {})).toBe(true);
    expect(evaluate({ kind: 'unary', operator: '!', operand: lit(1) }, {})).toBe(false);
    expect(evaluate({ kind: 'unary', operator: '!', operand: lit('x') }, {})).toBe(false);
  });

  it('unary - negates a number and rejects non-numbers', () => {
    expect(evaluate({ kind: 'unary', operator: '-', operand: lit(5) }, {})).toBe(-5);
    expect(() => evaluate({ kind: 'unary', operator: '-', operand: lit('x') }, {})).toThrow(
      ExpressionEvaluationError,
    );
  });
});

// Exported directly (not just an evaluator-internal detail) because
// conditional text/choices (Phase 3+) need the exact same truthiness
// rule used above, applied to an already-evaluated condition result.
describe('truthy', () => {
  it('a boolean is itself', () => {
    expect(truthy(true)).toBe(true);
    expect(truthy(false)).toBe(false);
  });

  it('a number is truthy unless exactly zero', () => {
    expect(truthy(0)).toBe(false);
    expect(truthy(-0)).toBe(false);
    expect(truthy(1)).toBe(true);
    expect(truthy(-1)).toBe(true);
  });

  it('a string is truthy unless empty', () => {
    expect(truthy('')).toBe(false);
    expect(truthy('false')).toBe(true);
    expect(truthy('0')).toBe(true);
  });
});

describe('execute — assignment statements', () => {
  it('= replaces the variable, leaving every other variable untouched', () => {
    const stmt: AssignmentStatement = {
      kind: 'assignment',
      name: 'gold',
      operator: '=',
      value: lit(10),
    };
    const result = execute(stmt, { gold: 0, silver: 3 });
    expect(result).toEqual({ gold: 10, silver: 3 });
  });

  it('does not mutate the variables object passed in', () => {
    const original = { gold: 0 };
    const stmt: AssignmentStatement = {
      kind: 'assignment',
      name: 'gold',
      operator: '=',
      value: lit(10),
    };
    execute(stmt, original);
    expect(original).toEqual({ gold: 0 });
  });

  it.each([
    ['+=', 5, 3, 8],
    ['-=', 5, 3, 2],
    ['*=', 5, 3, 15],
    ['/=', 10, 2, 5],
  ] as const)(
    '%s reads the current value as the left operand',
    (operator, start, operand, expected) => {
      const stmt: AssignmentStatement = {
        kind: 'assignment',
        name: 'x',
        operator,
        value: lit(operand),
      };
      expect(execute(stmt, { x: start })).toEqual({ x: expected });
    },
  );

  it('compound assignment to an undefined variable throws', () => {
    const stmt: AssignmentStatement = {
      kind: 'assignment',
      name: 'missing',
      operator: '+=',
      value: lit(1),
    };
    expect(() => execute(stmt, {})).toThrow(ExpressionEvaluationError);
  });

  it('the assignment value can itself reference other variables', () => {
    const stmt: AssignmentStatement = {
      kind: 'assignment',
      name: 'total',
      operator: '=',
      value: { kind: 'binary', operator: '+', left: v('a'), right: v('b') },
    };
    expect(execute(stmt, { a: 2, b: 3, total: 0 })).toEqual({ a: 2, b: 3, total: 5 });
  });
});

// DEV-199 Phase 10: Ink's LIST type. kettleState's declared order is
// cold(0), boiling(1), recently_boiled(2) — every list() fixture
// below reuses that origin/ordering so comparison/ordering tests
// read against one consistent declaration, matching a real `LIST
// kettleState = cold, (boiling), recently_boiled`.
const KETTLE_ALL = [
  { name: 'cold', ordinal: 0 },
  { name: 'boiling', ordinal: 1 },
  { name: 'recently_boiled', ordinal: 2 },
];

function list(...names: string[]): Expression {
  const items = KETTLE_ALL.filter((i) => names.includes(i.name));
  const value: ListValue = { kind: 'list', origin: 'kettleState', items, allItems: KETTLE_ALL };
  return { kind: 'literal', value };
}

function listVal(...names: string[]): ListValue {
  return evaluate(list(...names), {}) as ListValue;
}

/** The genuine empty-list literal `()` the parser produces — origin
 * `''`, `allItems: []` — distinct from `list()` above, which is
 * still tagged with kettleState's real origin/allItems despite
 * having no active items. Needed to test that a union/difference
 * against the TRUE origin-less empty literal doesn't lose the other
 * operand's real origin. */
function emptyList(): Expression {
  return { kind: 'literal', value: { kind: 'list', origin: '', items: [], allItems: [] } };
}

describe('evaluate — LIST truthiness', () => {
  it('is truthy iff non-empty', () => {
    expect(truthy(listVal('cold'))).toBe(true);
    expect(truthy(listVal())).toBe(false);
  });
});

describe('evaluate — LIST set operators (+/-)', () => {
  it('+= style union adds a member without duplicating an existing one', () => {
    const result = evaluate(
      { kind: 'binary', operator: '+', left: list('cold'), right: list('boiling') },
      {},
    ) as ListValue;
    expect(result.items.map((i) => i.name).sort()).toEqual(['boiling', 'cold']);

    const noDupe = evaluate(
      { kind: 'binary', operator: '+', left: list('cold'), right: list('cold') },
      {},
    ) as ListValue;
    expect(noDupe.items).toHaveLength(1);
  });

  it('-= style difference removes a member, no-op if absent', () => {
    const result = evaluate(
      { kind: 'binary', operator: '-', left: list('cold', 'boiling'), right: list('cold') },
      {},
    ) as ListValue;
    expect(result.items.map((i) => i.name)).toEqual(['boiling']);

    const noop = evaluate(
      { kind: 'binary', operator: '-', left: list('cold'), right: list('boiling') },
      {},
    ) as ListValue;
    expect(noop.items.map((i) => i.name)).toEqual(['cold']);
  });

  it('union/difference against the true empty-list literal `()` keeps the OTHER operand’s real origin/allItems', () => {
    const unionLeftEmpty = evaluate(
      { kind: 'binary', operator: '+', left: emptyList(), right: list('cold') },
      {},
    ) as ListValue;
    expect(unionLeftEmpty.origin).toBe('kettleState');
    expect(unionLeftEmpty.allItems).toEqual(KETTLE_ALL);

    const unionRightEmpty = evaluate(
      { kind: 'binary', operator: '+', left: list('cold'), right: emptyList() },
      {},
    ) as ListValue;
    expect(unionRightEmpty.origin).toBe('kettleState');
    expect(unionRightEmpty.allItems).toEqual(KETTLE_ALL);

    const differenceLeftEmpty = evaluate(
      { kind: 'binary', operator: '-', left: emptyList(), right: list('cold') },
      {},
    ) as ListValue;
    expect(differenceLeftEmpty.origin).toBe('kettleState');
    expect(differenceLeftEmpty.allItems).toEqual(KETTLE_ALL);
  });

  it('* / % never apply to LIST values', () => {
    for (const operator of ['*', '/', '%'] as const) {
      expect(() =>
        evaluate({ kind: 'binary', operator, left: list('cold'), right: list('cold') }, {}),
      ).toThrow(ExpressionEvaluationError);
    }
  });
});

describe('evaluate — LIST equality', () => {
  it('== is exact-set equality, independent of how each side was built', () => {
    expect(
      evaluate(
        {
          kind: 'binary',
          operator: '==',
          left: list('cold', 'boiling'),
          right: list('boiling', 'cold'),
        },
        {},
      ),
    ).toBe(true);
    expect(
      evaluate({ kind: 'binary', operator: '==', left: list('cold'), right: list('boiling') }, {}),
    ).toBe(false);
    expect(
      evaluate({ kind: 'binary', operator: '!=', left: list('cold'), right: list('boiling') }, {}),
    ).toBe(true);
  });
});

describe('evaluate — LIST membership (has/hasnt)', () => {
  it('has is true iff every item on the right is present on the left', () => {
    expect(
      evaluate(
        { kind: 'binary', operator: 'has', left: list('cold', 'boiling'), right: list('cold') },
        {},
      ),
    ).toBe(true);
    expect(
      evaluate(
        { kind: 'binary', operator: 'has', left: list('cold'), right: list('cold', 'boiling') },
        {},
      ),
    ).toBe(false);
  });

  it('hasnt is the negation of has', () => {
    expect(
      evaluate(
        { kind: 'binary', operator: 'hasnt', left: list('cold'), right: list('boiling') },
        {},
      ),
    ).toBe(true);
  });
});

describe('evaluate — LIST positional comparison', () => {
  // Ink's own semantics: a < b iff a's MAXIMUM ordinal is below b's
  // MINIMUM — "every item in a precedes every item in b" — not a
  // length or lexicographic comparison.
  it('< / <= / > / >= compare by declared order, not set size', () => {
    expect(
      evaluate({ kind: 'binary', operator: '<', left: list('cold'), right: list('boiling') }, {}),
    ).toBe(true);
    expect(
      evaluate(
        {
          kind: 'binary',
          operator: '<',
          left: list('cold', 'boiling'),
          right: list('recently_boiled'),
        },
        {},
      ),
    ).toBe(true);
    expect(
      evaluate(
        { kind: 'binary', operator: '>', left: list('recently_boiled'), right: list('cold') },
        {},
      ),
    ).toBe(true);
    expect(
      evaluate(
        { kind: 'binary', operator: '<=', left: list('boiling'), right: list('boiling') },
        {},
      ),
    ).toBe(true);
    expect(
      evaluate(
        { kind: 'binary', operator: '<', left: list('boiling'), right: list('boiling') },
        {},
      ),
    ).toBe(false);
  });

  it('compares an empty list against a non-empty one asymmetrically, matching ink-engine', () => {
    // Real Ink: a non-empty list is strictly greater than an empty
    // one, and an empty list is strictly less than a non-empty one —
    // NOT "always false when either side is empty".
    const expected: Record<'<' | '<=' | '>' | '>=', { emptyFirst: boolean; emptySecond: boolean }> =
      {
        '<': { emptyFirst: true, emptySecond: false },
        '<=': { emptyFirst: true, emptySecond: false },
        '>': { emptyFirst: false, emptySecond: true },
        '>=': { emptyFirst: false, emptySecond: true },
      };
    for (const operator of ['<', '<=', '>', '>='] as const) {
      expect(evaluate({ kind: 'binary', operator, left: list(), right: list('cold') }, {})).toBe(
        expected[operator].emptyFirst,
      );
      expect(evaluate({ kind: 'binary', operator, left: list('cold'), right: list() }, {})).toBe(
        expected[operator].emptySecond,
      );
    }
  });

  it('>= / <= compare min-to-min AND max-to-max, not a cross min-to-max comparison', () => {
    // a=[boiling,recently_boiled] (ordinals 1,2), b=[cold,boiling] (0,1):
    // min(a)=1 >= min(b)=0 AND max(a)=2 >= max(b)=1 -> true.
    const a = list('boiling', 'recently_boiled');
    const b = list('cold', 'boiling');
    expect(evaluate({ kind: 'binary', operator: '>=', left: a, right: b }, {})).toBe(true);
    expect(evaluate({ kind: 'binary', operator: '<=', left: b, right: a }, {})).toBe(true);

    // c=[boiling] (ordinal 1), d=[cold,recently_boiled] (0,2):
    // min(c)=1 >= min(d)=0 (true) but max(c)=1 >= max(d)=2 is false,
    // so the AND makes the whole comparison false — a naive cross
    // comparison (min(c)=1 vs max(d)=2) would also say false here,
    // so this case specifically exercises the max(c)>=max(d) half of
    // the real formula, not just the min half.
    const c = list('boiling');
    const d = list('cold', 'recently_boiled');
    expect(evaluate({ kind: 'binary', operator: '>=', left: c, right: d }, {})).toBe(false);
  });
});

describe('evaluate — LIST query functions', () => {
  it('LIST_COUNT returns the number of active items', () => {
    expect(
      evaluate({ kind: 'listFunction', name: 'LIST_COUNT', args: [list('cold', 'boiling')] }, {}),
    ).toBe(2);
    expect(evaluate({ kind: 'listFunction', name: 'LIST_COUNT', args: [list()] }, {})).toBe(0);
  });

  it('LIST_VALUE returns the highest active item’s ordinal', () => {
    expect(
      evaluate({ kind: 'listFunction', name: 'LIST_VALUE', args: [list('boiling')] }, {}),
    ).toBe(1);
    expect(
      evaluate(
        { kind: 'listFunction', name: 'LIST_VALUE', args: [list('cold', 'recently_boiled')] },
        {},
      ),
    ).toBe(2);
  });

  it('LIST_MIN/LIST_MAX return single-item LISTs, empty if the source is empty', () => {
    const min = evaluate(
      { kind: 'listFunction', name: 'LIST_MIN', args: [list('boiling', 'recently_boiled')] },
      {},
    ) as ListValue;
    expect(min.items.map((i) => i.name)).toEqual(['boiling']);

    const max = evaluate(
      { kind: 'listFunction', name: 'LIST_MAX', args: [list('boiling', 'recently_boiled')] },
      {},
    ) as ListValue;
    expect(max.items.map((i) => i.name)).toEqual(['recently_boiled']);

    const emptyMin = evaluate(
      { kind: 'listFunction', name: 'LIST_MIN', args: [list()] },
      {},
    ) as ListValue;
    expect(emptyMin.items).toEqual([]);
  });

  it('LIST_ALL returns every declared member, active or not', () => {
    const all = evaluate(
      { kind: 'listFunction', name: 'LIST_ALL', args: [list('cold')] },
      {},
    ) as ListValue;
    expect(all.items.map((i) => i.name).sort()).toEqual(['boiling', 'cold', 'recently_boiled']);
  });

  it('LIST_INVERT returns every declared member NOT currently active', () => {
    const inverted = evaluate(
      { kind: 'listFunction', name: 'LIST_INVERT', args: [list('cold')] },
      {},
    ) as ListValue;
    expect(inverted.items.map((i) => i.name).sort()).toEqual(['boiling', 'recently_boiled']);
  });

  it('LIST_RANGE filters the INPUT list’s own active items by ordinal bounds, not the origin’s full declared set', () => {
    const byNumber = evaluate(
      {
        kind: 'listFunction',
        name: 'LIST_RANGE',
        args: [
          list('cold', 'boiling', 'recently_boiled'),
          { kind: 'literal', value: 1 },
          { kind: 'literal', value: 2 },
        ],
      },
      {},
    ) as ListValue;
    expect(byNumber.items.map((i) => i.name).sort()).toEqual(['boiling', 'recently_boiled']);

    const byListBound = evaluate(
      {
        kind: 'listFunction',
        name: 'LIST_RANGE',
        args: [list('boiling', 'recently_boiled'), list('boiling'), list('boiling')],
      },
      {},
    ) as ListValue;
    expect(byListBound.items.map((i) => i.name)).toEqual(['boiling']);

    // A member active in the origin's full set but NOT active in the
    // input list passed to LIST_RANGE must not appear in the result,
    // even though it's within the ordinal bounds — proving this
    // filters `items`, not `allItems`.
    const excludesInactive = evaluate(
      {
        kind: 'listFunction',
        name: 'LIST_RANGE',
        args: [list('cold'), { kind: 'literal', value: 0 }, { kind: 'literal', value: 2 }],
      },
      {},
    ) as ListValue;
    expect(excludesInactive.items.map((i) => i.name)).toEqual(['cold']);
  });

  it('every LIST_* function rejects a non-LIST argument', () => {
    expect(() =>
      evaluate(
        { kind: 'listFunction', name: 'LIST_COUNT', args: [{ kind: 'literal', value: 5 }] },
        {},
      ),
    ).toThrow(ExpressionEvaluationError);
  });
});

describe('isListValue', () => {
  it('distinguishes a ListValue from every other VariableValue', () => {
    expect(isListValue(listVal('cold'))).toBe(true);
    expect(isListValue(5)).toBe(false);
    expect(isListValue('cold')).toBe(false);
    expect(isListValue(true)).toBe(false);
  });
});

describe('expressionUsesListFeatures', () => {
  it('a bare LIST-valued literal is detected with no context', () => {
    expect(expressionUsesListFeatures(list('cold'))).toBe(true);
  });

  it('has/hasnt is detected even between two plain variable operands', () => {
    const expr: Expression = {
      kind: 'binary',
      operator: 'has',
      left: { kind: 'variable', name: 'kettleState' },
      right: { kind: 'variable', name: 'boiling' },
    };
    expect(expressionUsesListFeatures(expr)).toBe(true);
  });

  it('a LIST_* call is detected with no context', () => {
    expect(
      expressionUsesListFeatures({
        kind: 'listFunction',
        name: 'LIST_COUNT',
        args: [list('cold')],
      }),
    ).toBe(true);
  });

  it('a bare variable reference is NOT detected without a listVariableNames set', () => {
    expect(expressionUsesListFeatures({ kind: 'variable', name: 'kettleState' })).toBe(false);
  });

  it('a bare variable reference IS detected when its name is in listVariableNames', () => {
    const expr: Expression = { kind: 'variable', name: 'kettleState' };
    expect(expressionUsesListFeatures(expr, new Set(['kettleState']))).toBe(true);
    expect(expressionUsesListFeatures(expr, new Set(['someOtherVar']))).toBe(false);
  });

  it('detects a list-typed variable buried inside a binary/logical/unary subtree', () => {
    const names = new Set(['kettleState']);
    const buried: Expression = {
      kind: 'logical',
      operator: '&&',
      left: { kind: 'unary', operator: '!', operand: { kind: 'variable', name: 'kettleState' } },
      right: { kind: 'literal', value: true },
    };
    expect(expressionUsesListFeatures(buried, names)).toBe(true);
  });

  it('a plain numeric/string/bool expression tree is never flagged', () => {
    const expr: Expression = {
      kind: 'binary',
      operator: '+',
      left: { kind: 'variable', name: 'gold' },
      right: { kind: 'literal', value: 5 },
    };
    expect(expressionUsesListFeatures(expr)).toBe(false);
  });

  it('a call expression is only flagged via a LIST-bearing argument', () => {
    const plainCall: Expression = {
      kind: 'call',
      name: 'double',
      args: [{ kind: 'variable', name: 'x' }],
    };
    expect(expressionUsesListFeatures(plainCall)).toBe(false);
    const listArgCall: Expression = { kind: 'call', name: 'f', args: [list('cold')] };
    expect(expressionUsesListFeatures(listArgCall)).toBe(true);
  });
});

describe('expressionUsesFunctionCalls', () => {
  it('a plain expression tree is never flagged', () => {
    const expr: Expression = {
      kind: 'binary',
      operator: '+',
      left: { kind: 'variable', name: 'gold' },
      right: { kind: 'literal', value: 5 },
    };
    expect(expressionUsesFunctionCalls(expr)).toBe(false);
  });

  it('a bare call is flagged', () => {
    expect(expressionUsesFunctionCalls({ kind: 'call', name: 'double', args: [] })).toBe(true);
  });

  it('a call buried inside a binary/logical/unary subtree is flagged', () => {
    const buried: Expression = {
      kind: 'logical',
      operator: '&&',
      left: { kind: 'unary', operator: '!', operand: { kind: 'call', name: 'f', args: [] } },
      right: { kind: 'literal', value: true },
    };
    expect(expressionUsesFunctionCalls(buried)).toBe(true);
  });

  it('a call nested inside a LIST_* builtin argument is flagged', () => {
    expect(
      expressionUsesFunctionCalls({
        kind: 'listFunction',
        name: 'LIST_COUNT',
        args: [{ kind: 'call', name: 'f', args: [] }],
      }),
    ).toBe(true);
  });
});

// Function-knot calls (DEV-199 Phase 10b): `evaluate`/`execute` need
// an explicit `callFunction` handler to run a `call` expression at
// all — see expression-evaluator.ts's header for why this can't just
// be baked into the pure evaluator. These tests exercise the handler
// CONTRACT in isolation (a hand-rolled stub), not the real
// function-interpreter.ts implementation — that has its own test
// file.
describe('evaluate/execute — function calls', () => {
  function stubDouble(): CallFunctionHandler {
    return (name, args, variables) => {
      if (name !== 'double') throw new ExpressionEvaluationError(`unknown: ${name}`);
      const n = args[0];
      if (typeof n !== 'number') throw new ExpressionEvaluationError('double expects a number');
      return { value: n * 2, variables };
    };
  }

  it('throws a clear error when no callFunction handler is provided', () => {
    const expr: Expression = {
      kind: 'call',
      name: 'double',
      args: [{ kind: 'literal', value: 5 }],
    };
    expect(() => evaluate(expr, {})).toThrow(ExpressionEvaluationError);
    expect(() => evaluate(expr, {})).toThrow(/callFunction/);
  });

  it('evaluates a call when a handler is provided', () => {
    const expr: Expression = {
      kind: 'call',
      name: 'double',
      args: [{ kind: 'literal', value: 5 }],
    };
    expect(evaluate(expr, {}, stubDouble())).toBe(10);
  });

  it('evaluates a call used inside a larger expression', () => {
    const expr: Expression = {
      kind: 'binary',
      operator: '>',
      left: { kind: 'call', name: 'double', args: [{ kind: 'literal', value: 5 }] },
      right: { kind: 'literal', value: 8 },
    };
    expect(evaluate(expr, {}, stubDouble())).toBe(true);
  });

  it('evaluates nested calls', () => {
    const inner: Expression = {
      kind: 'call',
      name: 'double',
      args: [{ kind: 'literal', value: 2 }],
    };
    const outer: Expression = { kind: 'call', name: 'double', args: [inner] };
    expect(evaluate(outer, {}, stubDouble())).toBe(8);
  });

  it('evaluateWithEffects reports the variable store a call mutated', () => {
    const mutate: CallFunctionHandler = (_name, _args, variables) => ({
      value: 0,
      variables: { ...variables, sideEffect: 'touched' },
    });
    const expr: Expression = { kind: 'call', name: 'f', args: [] };
    const result = evaluateWithEffects(expr, { gold: 1 }, mutate);
    expect(result.value).toBe(0);
    expect(result.variables).toEqual({ gold: 1, sideEffect: 'touched' });
  });

  it('plain evaluate drops a call side effect (documented limitation)', () => {
    const mutate: CallFunctionHandler = (_name, _args, variables) => ({
      value: 0,
      variables: { ...variables, sideEffect: 'touched' },
    });
    const outerVariables = { gold: 1 };
    evaluate({ kind: 'call', name: 'f', args: [] }, outerVariables, mutate);
    // The caller's own object is untouched — evaluate never mutates
    // its input, and (being `evaluate`, not `evaluateWithEffects`)
    // the mutated store it computed internally isn't handed back.
    expect(outerVariables).toEqual({ gold: 1 });
  });

  it('execute on an assignment propagates a call side effect into the result', () => {
    const mutate: CallFunctionHandler = (_name, _args, variables) => ({
      value: 42,
      variables: { ...variables, sideEffect: 'touched' },
    });
    const stmt: AssignmentStatement = {
      kind: 'assignment',
      name: 'gold',
      operator: '=',
      value: { kind: 'call', name: 'f', args: [] },
    };
    const result = execute(stmt, { gold: 1 }, mutate);
    expect(result).toEqual({ gold: 42, sideEffect: 'touched' });
  });

  it('execute is a no-op for a bare return statement', () => {
    const variables = { gold: 1 };
    expect(execute({ kind: 'return' }, variables)).toBe(variables);
  });

  it('execute is a no-op for a return statement with a value', () => {
    const variables = { gold: 1 };
    expect(execute({ kind: 'return', value: { kind: 'literal', value: 5 } }, variables)).toBe(
      variables,
    );
  });
});
