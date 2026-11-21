import { describe, it, expect } from 'vitest';
import {
  evaluate,
  execute,
  truthy,
  isListValue,
  ExpressionEvaluationError,
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

  it('never compares true against an empty list on either side', () => {
    for (const operator of ['<', '<=', '>', '>='] as const) {
      expect(evaluate({ kind: 'binary', operator, left: list(), right: list('cold') }, {})).toBe(
        false,
      );
      expect(evaluate({ kind: 'binary', operator, left: list('cold'), right: list() }, {})).toBe(
        false,
      );
    }
  });
});

describe('evaluate — LIST query functions', () => {
  it('LIST_COUNT returns the number of active items', () => {
    expect(
      evaluate({ kind: 'listFunction', name: 'LIST_COUNT', args: [list('cold', 'boiling')] }, {}),
    ).toBe(2);
    expect(evaluate({ kind: 'listFunction', name: 'LIST_COUNT', args: [list()] }, {})).toBe(0);
  });

  it('LIST_VALUE returns the lowest active item’s ordinal', () => {
    expect(
      evaluate({ kind: 'listFunction', name: 'LIST_VALUE', args: [list('boiling')] }, {}),
    ).toBe(1);
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

  it('LIST_RANGE returns every declared member within the ordinal bounds, by number or single-item list', () => {
    const byNumber = evaluate(
      {
        kind: 'listFunction',
        name: 'LIST_RANGE',
        args: [list('cold'), { kind: 'literal', value: 1 }, { kind: 'literal', value: 2 }],
      },
      {},
    ) as ListValue;
    expect(byNumber.items.map((i) => i.name).sort()).toEqual(['boiling', 'recently_boiled']);

    const byListBound = evaluate(
      {
        kind: 'listFunction',
        name: 'LIST_RANGE',
        args: [list('cold'), list('boiling'), list('boiling')],
      },
      {},
    ) as ListValue;
    expect(byListBound.items.map((i) => i.name)).toEqual(['boiling']);
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
