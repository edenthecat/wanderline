import { describe, it, expect } from 'vitest';
import {
  createFunctionCaller,
  evaluate,
  execute,
  ExpressionEvaluationError,
  MAX_FUNCTION_CALL_DEPTH,
  type ContentBlock,
  type FunctionKnotLike,
  type Expression,
} from '@wanderline/shared';

// Function-knots (DEV-199 Phase 10b): createFunctionCaller builds the
// `callFunction` handler expression-evaluator.ts's `evaluate`/
// `execute` need to actually RUN a `=== function foo(x) ===` knot's
// content. These tests exercise it against hand-built
// `FunctionKnotLike` definitions (params + content), not against a
// real parsed StoryGraph — ink-parser.test.ts covers the parse side,
// and backend's own tests cover wiring a real StoryNode in.

function returnStmt(value?: Expression): ContentBlock {
  return { kind: 'assignment', statement: { kind: 'return', value } };
}
function assignStmt(name: string, value: Expression): ContentBlock {
  return { kind: 'assignment', statement: { kind: 'assignment', name, operator: '=', value } };
}
const v = (name: string): Expression => ({ kind: 'variable', name });
const lit = (value: number | string | boolean): Expression => ({ kind: 'literal', value });

describe('createFunctionCaller', () => {
  it('runs a simple function and returns its value', () => {
    const double: FunctionKnotLike = {
      params: ['x'],
      content: [returnStmt({ kind: 'binary', operator: '*', left: v('x'), right: lit(2) })],
    };
    const caller = createFunctionCaller({
      getFunction: (name) => (name === 'double' ? double : undefined),
    });
    const expr: Expression = { kind: 'call', name: 'double', args: [lit(5)] };
    expect(evaluate(expr, {}, caller)).toBe(10);
  });

  it('a function with no return statement evaluates to the empty string, not a crash', () => {
    const sideEffectOnly: FunctionKnotLike = {
      params: [],
      content: [assignStmt('touched', lit(true))],
    };
    const caller = createFunctionCaller({
      getFunction: (name) => (name === 'noop' ? sideEffectOnly : undefined),
    });
    const expr: Expression = { kind: 'call', name: 'noop', args: [] };
    expect(evaluate(expr, {}, caller)).toBe('');
  });

  it('a bare `return` with no value evaluates to the empty string', () => {
    const fn: FunctionKnotLike = { params: [], content: [returnStmt()] };
    const caller = createFunctionCaller({ getFunction: () => fn });
    expect(evaluate({ kind: 'call', name: 'f', args: [] }, {}, caller)).toBe('');
  });

  it('a function body assigning to a global mutates the caller-visible store', () => {
    const fn: FunctionKnotLike = {
      params: [],
      content: [
        assignStmt('gold', { kind: 'binary', operator: '+', left: v('gold'), right: lit(10) }),
      ],
    };
    const caller = createFunctionCaller({ getFunction: () => fn });
    const stmt = {
      kind: 'assignment' as const,
      name: 'ignored',
      operator: '=' as const,
      value: { kind: 'call' as const, name: 'addGold', args: [] },
    };
    const result = execute(stmt, { gold: 5 }, caller);
    expect(result.gold).toBe(15);
  });

  it('a parameter shadows a same-named global without leaking back out', () => {
    // Global `x` starts at 100; the function's OWN param is also
    // named `x`, bound to the call's argument (1). Inside the body it
    // reassigns its local `x` to 999 — that must stay local; the
    // caller's global `x` must still read 100 afterward.
    const fn: FunctionKnotLike = {
      params: ['x'],
      content: [assignStmt('x', lit(999)), returnStmt(v('x'))],
    };
    const caller = createFunctionCaller({ getFunction: () => fn });
    const stmt = {
      kind: 'assignment' as const,
      name: 'result',
      operator: '=' as const,
      value: { kind: 'call' as const, name: 'f', args: [lit(1)] },
    };
    const outerVariables = { x: 100 };
    const next = execute(stmt, outerVariables, caller);
    expect(next.result).toBe(999); // the call's own return value
    expect(next.x).toBe(100); // the global, untouched by the shadowed local
  });

  it('nested calls: f(g(x))', () => {
    const inc: FunctionKnotLike = {
      params: ['n'],
      content: [returnStmt({ kind: 'binary', operator: '+', left: v('n'), right: lit(1) })],
    };
    const double: FunctionKnotLike = {
      params: ['n'],
      content: [returnStmt({ kind: 'binary', operator: '*', left: v('n'), right: lit(2) })],
    };
    const caller = createFunctionCaller({
      getFunction: (name) => (name === 'inc' ? inc : name === 'double' ? double : undefined),
    });
    const expr: Expression = {
      kind: 'call',
      name: 'double',
      args: [{ kind: 'call', name: 'inc', args: [lit(4)] }],
    };
    expect(evaluate(expr, {}, caller)).toBe(10); // double(inc(4)) = double(5) = 10
  });

  it('a nested call does not see an enclosing call’s parameter as if it were a global (found in review)', () => {
    // Global `x` is 100. `outer(x)` binds its OWN param `x` to
    // whatever it's called with, then calls `readGlobal()` — which
    // has no params of its own and just returns the bare global `x`.
    // `readGlobal` must see the REAL global (100), not outer's
    // currently-bound parameter — Ink has no closures.
    const readGlobal: FunctionKnotLike = { params: [], content: [returnStmt(v('x'))] };
    const outer: FunctionKnotLike = {
      params: ['x'],
      content: [returnStmt({ kind: 'call', name: 'readGlobal', args: [] })],
    };
    const caller = createFunctionCaller({
      getFunction: (name) =>
        name === 'outer' ? outer : name === 'readGlobal' ? readGlobal : undefined,
    });
    const expr: Expression = { kind: 'call', name: 'outer', args: [lit(1)] };
    expect(evaluate(expr, { x: 100 }, caller)).toBe(100);
  });

  it('a nested call’s global write is visible to the OUTER call after it returns', () => {
    // bump() increments the real global `count`, unrelated to outer's
    // own parameter `n`. outer() calls bump() twice, then returns the
    // (now-mutated) global — confirms a global effect from a nested
    // call propagates back through the outer call's own scope, not
    // just out to evaluate()'s original caller.
    const bump: FunctionKnotLike = {
      params: [],
      content: [
        assignStmt('count', { kind: 'binary', operator: '+', left: v('count'), right: lit(1) }),
      ],
    };
    const outer: FunctionKnotLike = {
      params: ['n'],
      content: [
        {
          kind: 'assignment',
          statement: {
            kind: 'assignment',
            name: 'n',
            operator: '=',
            value: { kind: 'call', name: 'bump', args: [] },
          },
        },
        {
          kind: 'assignment',
          statement: {
            kind: 'assignment',
            name: 'n',
            operator: '=',
            value: { kind: 'call', name: 'bump', args: [] },
          },
        },
        returnStmt(v('count')),
      ],
    };
    const caller = createFunctionCaller({
      getFunction: (name) => (name === 'outer' ? outer : name === 'bump' ? bump : undefined),
    });
    expect(evaluate({ kind: 'call', name: 'outer', args: [lit(5)] }, { count: 0 }, caller)).toBe(2);
  });

  it('a function parameter named __proto__ is bound as an ordinary own property, not Object.prototype (found in review)', () => {
    const identity: FunctionKnotLike = {
      params: ['__proto__'],
      content: [returnStmt(v('__proto__'))],
    };
    const caller = createFunctionCaller({ getFunction: () => identity });
    const expr: Expression = { kind: 'call', name: 'identity', args: [lit(42)] };
    expect(evaluate(expr, {}, caller)).toBe(42);
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('a function calling itself recursively is detected and bounded by the depth guard', () => {
    // This parser has no if/else statement form (see
    // function-interpreter.ts's header) — a function's content is a
    // flat, unconditional sequence of statements, so a self-call can
    // never encode a base case that stops it. That means EVERY
    // directly-recursive function-knot in this codebase currently
    // recurses unconditionally, and the only thing standing between
    // that and a stack overflow is the depth guard — this test
    // confirms recursion actually recurses (each call really does
    // invoke the function again) and that the guard catches it with
    // a clear error rather than crashing the process.
    let calls = 0;
    const countdown: FunctionKnotLike = {
      params: ['n'],
      content: [
        returnStmt({
          kind: 'call',
          name: 'countdown',
          args: [{ kind: 'binary', operator: '-', left: v('n'), right: lit(1) }],
        }),
      ],
    };
    const caller = createFunctionCaller({
      getFunction: (name) => {
        if (name !== 'countdown') return undefined;
        calls++;
        return countdown;
      },
    });
    const expr: Expression = { kind: 'call', name: 'countdown', args: [lit(5)] };
    expect(() => evaluate(expr, {}, caller)).toThrow(ExpressionEvaluationError);
    expect(() => evaluate(expr, {}, caller)).toThrow(/depth/);
    expect(calls).toBeGreaterThan(MAX_FUNCTION_CALL_DEPTH);
  });

  it('enforces a maximum call depth rather than recursing forever', () => {
    const infinite: FunctionKnotLike = {
      params: [],
      content: [returnStmt({ kind: 'call', name: 'loop', args: [] })],
    };
    const caller = createFunctionCaller({ getFunction: () => infinite });
    expect(() => evaluate({ kind: 'call', name: 'loop', args: [] }, {}, caller)).toThrow(
      new RegExp(String(MAX_FUNCTION_CALL_DEPTH)),
    );
  });

  it('rejects a call to an undeclared function', () => {
    const caller = createFunctionCaller({ getFunction: () => undefined });
    expect(() => evaluate({ kind: 'call', name: 'missing', args: [] }, {}, caller)).toThrow(
      /undeclared/,
    );
  });

  it('rejects a call with the wrong number of arguments', () => {
    const fn: FunctionKnotLike = { params: ['a', 'b'], content: [returnStmt(v('a'))] };
    const caller = createFunctionCaller({ getFunction: () => fn });
    expect(() => evaluate({ kind: 'call', name: 'f', args: [lit(1)] }, {}, caller)).toThrow(
      /expects 2 argument/,
    );
  });

  it('ignores text blocks inside a function body (documented limitation)', () => {
    const fn: FunctionKnotLike = {
      params: [],
      content: [{ kind: 'text', text: 'hello', tags: [] }, returnStmt(lit(7))],
    };
    const caller = createFunctionCaller({ getFunction: () => fn });
    expect(evaluate({ kind: 'call', name: 'f', args: [] }, {}, caller)).toBe(7);
  });

  it('a side effect from a NESTED call inside the return expression itself is not lost', () => {
    // `bump` mutates global `touched`; `wrapper` returns `bump(x)`
    // directly in its own `return` statement, rather than assigning
    // it to a local first. The nested call's side effect on `touched`
    // must still surface in the caller's variables after `wrapper`
    // itself returns.
    const bump: FunctionKnotLike = {
      params: ['n'],
      content: [assignStmt('touched', lit(true)), returnStmt(v('n'))],
    };
    const wrapper: FunctionKnotLike = {
      params: ['x'],
      content: [returnStmt({ kind: 'call', name: 'bump', args: [v('x')] })],
    };
    const caller = createFunctionCaller({
      getFunction: (name) => (name === 'bump' ? bump : name === 'wrapper' ? wrapper : undefined),
    });
    const stmt = {
      kind: 'assignment' as const,
      name: 'result',
      operator: '=' as const,
      value: { kind: 'call' as const, name: 'wrapper', args: [lit(5)] },
    };
    const next = execute(stmt, { touched: false }, caller);
    expect(next.result).toBe(5);
    expect(next.touched).toBe(true);
  });

  it('a function with no params can be called with zero arguments', () => {
    const fn: FunctionKnotLike = { content: [returnStmt(lit(1))] };
    const caller = createFunctionCaller({ getFunction: () => fn });
    expect(evaluate({ kind: 'call', name: 'f', args: [] }, {}, caller)).toBe(1);
  });
});
