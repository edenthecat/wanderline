/**
 * Pure evaluator for the canonical expression AST (expression-types.ts).
 * No I/O, no story-graph knowledge — `evaluate`/`execute` just need a
 * `name -> value` map. Shared verbatim between backend (parse-time
 * validation, preview) and player-app (runtime playback) so a
 * condition can never evaluate differently in the editor than it does
 * during playback.
 *
 * Function-knot calls (DEV-199 Phase 10b — `{myFunc(x)}`) are the one
 * exception to "no story-graph knowledge": running one requires
 * walking a knot's content, which this module still must not know how
 * to do (that would mean importing StoryNode/StoryGraph types here,
 * and the backend's and player's shapes for "a node" genuinely
 * diverge). Instead, every entry point below takes an OPTIONAL
 * `callFunction` callback — a plain data-in/data-out function, not an
 * object carrying story-graph references — that a caller who DOES
 * have story-graph access (backend validation, player-app playback)
 * supplies. See `CallFunctionHandler` and function-interpreter.ts,
 * which builds one from a generic "knot-like" shape. Omitting the
 * callback is fully backward-compatible: every existing caller that
 * passes only (expr, variables) keeps working exactly as before, and
 * only actually fails if the expression tree turns out to contain a
 * `call` node.
 */

import type {
  AssignmentStatement,
  BinaryOperator,
  Expression,
  ListFunctionName,
  ListItem,
  ListValue,
  Statement,
  VariableValue,
} from './expression-types.js';

export class ExpressionEvaluationError extends Error {}

export function isListValue(value: VariableValue): value is ListValue {
  return typeof value === 'object' && value !== null && value.kind === 'list';
}

/**
 * Ink's own truthiness rule for a VariableValue: a boolean as itself,
 * a number as nonzero, a string as nonempty, a LIST as non-empty.
 * Exported (not just an internal evaluator detail) because any
 * caller that gates on a boolean Expression's result — conditional
 * text, conditional choice visibility — needs the exact same rule
 * the evaluator's own `!`/`&&`/`||` use, not a second ad-hoc
 * truthiness check that could diverge.
 */
export function truthy(value: VariableValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return value.items.length > 0;
}

/**
 * Does this expression tree use Ink's LIST type anywhere — a
 * list-valued literal, a `has`/`hasnt` operator, a LIST_* builtin
 * call, or a bare reference to a variable KNOWN to be LIST-typed?
 * Used by Twine dialect exporters (Harlowe/SugarCube/Chapbook have
 * no LIST equivalent) to reject a LIST-bearing expression up front,
 * rather than letting it slip through a `literal`/`binary` case that
 * doesn't itself check for list values (e.g. `+`/`==` between two
 * lists would otherwise mis-render as a plain string/object instead
 * of being caught).
 *
 * `listVariableNames` is required to catch a bare `{kind:'variable'}`
 * reference to a LIST-typed variable — nothing in the Expression
 * itself says a variable node is list-typed, so the caller must pass
 * the set of declared LIST variable names it knows about. Omitting it
 * only misses that one case; every other LIST-bearing shape (a
 * literal, has/hasnt, a LIST_* call) is still caught with no context
 * at all.
 */
export function expressionUsesListFeatures(
  expr: Expression,
  listVariableNames?: ReadonlySet<string>,
): boolean {
  switch (expr.kind) {
    case 'literal':
      return isListValue(expr.value);
    case 'variable':
      return listVariableNames?.has(expr.name) ?? false;
    case 'unary':
      return expressionUsesListFeatures(expr.operand, listVariableNames);
    case 'binary':
      return (
        expr.operator === 'has' ||
        expr.operator === 'hasnt' ||
        expressionUsesListFeatures(expr.left, listVariableNames) ||
        expressionUsesListFeatures(expr.right, listVariableNames)
      );
    case 'logical':
      return (
        expressionUsesListFeatures(expr.left, listVariableNames) ||
        expressionUsesListFeatures(expr.right, listVariableNames)
      );
    case 'listFunction':
      return true;
    case 'call':
      // A call itself isn't a LIST feature (it's Ink-only for an
      // entirely different reason — see expressionUsesFunctionCalls),
      // but an ARGUMENT could still be LIST-valued, e.g.
      // `f(cold)` or `f(x) has cold`.
      return expr.args.some((arg) => expressionUsesListFeatures(arg, listVariableNames));
  }
}

/**
 * Does this expression tree call a user-defined function-knot
 * anywhere (DEV-199 Phase 10b — `{myFunc(x)}`)? Used the same way as
 * `expressionUsesListFeatures` by the Twine dialect exporters
 * (Harlowe/SugarCube/Chapbook have no function-knot equivalent, and
 * no concept of a callable knot at all) to reject a call-bearing
 * expression up front, rather than letting it fall through to a
 * `case 'call'` in a dialect's own render switch that has no correct
 * rendering for it.
 */
export function expressionUsesFunctionCalls(expr: Expression): boolean {
  switch (expr.kind) {
    case 'literal':
    case 'variable':
      return false;
    case 'unary':
      return expressionUsesFunctionCalls(expr.operand);
    case 'binary':
    case 'logical':
      return expressionUsesFunctionCalls(expr.left) || expressionUsesFunctionCalls(expr.right);
    case 'listFunction':
      return expr.args.some((arg) => expressionUsesFunctionCalls(arg));
    case 'call':
      return true;
  }
}

/** De-duplicated by name — a union/difference result never carries
 * the same member twice, regardless of how many origins contributed
 * to it. */
function dedupeItems(items: ListItem[]): ListItem[] {
  const byName = new Map<string, ListItem>();
  for (const item of items) byName.set(item.name, item);
  return [...byName.values()];
}

/**
 * The empty-list literal `()` carries origin `''`/`allItems: []`, so a
 * union/difference against it must not blindly inherit the LEFT
 * operand's origin/allItems when the left side is the empty one —
 * take whichever operand actually has a real origin.
 */
function listOrigin(a: ListValue, b: ListValue): { origin: string; allItems: ListItem[] } {
  return a.origin
    ? { origin: a.origin, allItems: a.allItems }
    : { origin: b.origin, allItems: b.allItems };
}

function listUnion(a: ListValue, b: ListValue): ListValue {
  return {
    kind: 'list',
    ...listOrigin(a, b),
    items: dedupeItems([...a.items, ...b.items]),
  };
}

function listDifference(a: ListValue, b: ListValue): ListValue {
  const removeNames = new Set(b.items.map((item) => item.name));
  return {
    kind: 'list',
    ...listOrigin(a, b),
    items: a.items.filter((i) => !removeNames.has(i.name)),
  };
}

function listEquals(a: ListValue, b: ListValue): boolean {
  if (a.items.length !== b.items.length) return false;
  const bNames = new Set(b.items.map((item) => item.name));
  return a.items.every((item) => bNames.has(item.name));
}

function listHas(a: ListValue, b: ListValue): boolean {
  const aNames = new Set(a.items.map((item) => item.name));
  return b.items.every((item) => aNames.has(item.name));
}

/**
 * Positional-set comparison (Ink's own LIST comparison semantics,
 * not a lexicographic/length comparison) — matches ink-engine's
 * InkList.cs GreaterThan/GreaterThanOrEquals/LessThan/
 * LessThanOrEquals exactly, including their asymmetric empty-list
 * handling (an empty list compares as "smaller than anything" for
 * strict `<`/`>`, but is never itself greater than / less than
 * anything via the non-strict forms unless the other side is also
 * empty):
 *
 *   a > b  : a non-empty, AND (b empty OR min(a) > max(b))
 *   a >= b : a non-empty, AND (b empty OR (min(a)>=min(b) && max(a)>=max(b)))
 *   a < b  : b non-empty, AND (a empty OR max(a) < min(b))
 *   a <= b : b non-empty, AND (a empty OR (min(a)<=min(b) && max(a)<=max(b)))
 */
function listCompare(operator: '<' | '<=' | '>' | '>=', a: ListValue, b: ListValue): boolean {
  const ordinalsOf = (list: ListValue) => list.items.map((item) => item.ordinal);
  const minOf = (list: ListValue) => Math.min(...ordinalsOf(list));
  const maxOf = (list: ListValue) => Math.max(...ordinalsOf(list));
  switch (operator) {
    case '>':
      if (a.items.length === 0) return false;
      if (b.items.length === 0) return true;
      return minOf(a) > maxOf(b);
    case '>=':
      if (a.items.length === 0) return false;
      if (b.items.length === 0) return true;
      return minOf(a) >= minOf(b) && maxOf(a) >= maxOf(b);
    case '<':
      if (b.items.length === 0) return false;
      if (a.items.length === 0) return true;
      return maxOf(a) < minOf(b);
    case '<=':
      if (b.items.length === 0) return false;
      if (a.items.length === 0) return true;
      return minOf(a) <= minOf(b) && maxOf(a) <= maxOf(b);
  }
}

function evaluateBinary(
  operator: BinaryOperator,
  left: VariableValue,
  right: VariableValue,
): VariableValue {
  if (isListValue(left) || isListValue(right)) {
    return evaluateListBinary(operator, left, right);
  }
  switch (operator) {
    case '+':
      // String concatenation if either side is a string, matching
      // Ink's own `+` overload — otherwise numeric addition.
      if (typeof left === 'string' || typeof right === 'string') {
        return `${left}${right}`;
      }
      if (typeof left === 'number' && typeof right === 'number') return left + right;
      throw new ExpressionEvaluationError(`Cannot apply '+' to ${typeof left} and ${typeof right}`);
    case '-':
    case '*':
    case '/':
    case '%':
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw new ExpressionEvaluationError(`Operator '${operator}' requires two numbers`);
      }
      if (operator === '-') return left - right;
      if (operator === '*') return left * right;
      if (operator === '/') {
        if (right === 0) throw new ExpressionEvaluationError('Division by zero');
        return left / right;
      }
      // '%'
      if (right === 0) throw new ExpressionEvaluationError('Modulo by zero');
      return left % right;
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const comparable =
        (typeof left === 'number' && typeof right === 'number') ||
        (typeof left === 'string' && typeof right === 'string');
      if (!comparable) {
        throw new ExpressionEvaluationError(
          `Cannot compare ${typeof left} and ${typeof right} with '${operator}'`,
        );
      }
      if (operator === '<') return left < right;
      if (operator === '<=') return left <= right;
      if (operator === '>') return left > right;
      return left >= right;
    }
    case 'has':
    case 'hasnt':
      throw new ExpressionEvaluationError(`Operator '${operator}' requires two LIST values`);
  }
}

/**
 * LIST-valued operators. Reached whenever either operand is a
 * ListValue — every operator below requires BOTH sides to be lists
 * (Ink doesn't allow mixing a list with a plain number/string in
 * these operators, e.g. no "list + 1"), so a non-list operand on
 * either side is always a validation error, not silently coerced.
 */
function evaluateListBinary(
  operator: BinaryOperator,
  left: VariableValue,
  right: VariableValue,
): VariableValue {
  if (!isListValue(left) || !isListValue(right)) {
    throw new ExpressionEvaluationError(`Operator '${operator}' requires two LIST values`);
  }
  switch (operator) {
    case '+':
      return listUnion(left, right);
    case '-':
      return listDifference(left, right);
    case '==':
      return listEquals(left, right);
    case '!=':
      return !listEquals(left, right);
    case 'has':
      return listHas(left, right);
    case 'hasnt':
      return !listHas(left, right);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return listCompare(operator, left, right);
    case '*':
    case '/':
    case '%':
      throw new ExpressionEvaluationError(`Operator '${operator}' does not apply to LIST values`);
  }
}

function requireList(value: VariableValue, fnName: string): ListValue {
  if (!isListValue(value)) {
    throw new ExpressionEvaluationError(`${fnName} requires a LIST argument`);
  }
  return value;
}

/** A single-item LIST holding just `item`, same origin/full
 * definition as `source` — the shape LIST_MIN/LIST_MAX return. */
function singleItemList(source: ListValue, item: ListItem | undefined): ListValue {
  return {
    kind: 'list',
    origin: source.origin,
    items: item ? [item] : [],
    allItems: source.allItems,
  };
}

/** LIST_RANGE's min/max bounds accept either a raw ordinal number or
 * a single-item LIST (using that item's ordinal) — Ink allows both
 * forms interchangeably. */
function listRangeBound(value: VariableValue, fnName: string): number {
  if (typeof value === 'number') return value;
  if (isListValue(value) && value.items.length > 0) {
    return Math.min(...value.items.map((item) => item.ordinal));
  }
  throw new ExpressionEvaluationError(`${fnName}'s min/max arguments must be a number or LIST`);
}

function evaluateListFunction(name: ListFunctionName, args: VariableValue[]): VariableValue {
  switch (name) {
    case 'LIST_COUNT':
      return requireList(args[0], 'LIST_COUNT').items.length;
    case 'LIST_VALUE': {
      // Ink's ValueOfList returns the MAXIMUM ordinal (its highest
      // item), not the minimum — matches how a multi-item list's
      // "value" is meant to read as "how far up the list we've got".
      const list = requireList(args[0], 'LIST_VALUE');
      return list.items.length > 0 ? Math.max(...list.items.map((item) => item.ordinal)) : 0;
    }
    case 'LIST_MIN': {
      const list = requireList(args[0], 'LIST_MIN');
      const lowest = list.items.reduce<ListItem | undefined>(
        (min, item) => (!min || item.ordinal < min.ordinal ? item : min),
        undefined,
      );
      return singleItemList(list, lowest);
    }
    case 'LIST_MAX': {
      const list = requireList(args[0], 'LIST_MAX');
      const highest = list.items.reduce<ListItem | undefined>(
        (max, item) => (!max || item.ordinal > max.ordinal ? item : max),
        undefined,
      );
      return singleItemList(list, highest);
    }
    case 'LIST_ALL': {
      const list = requireList(args[0], 'LIST_ALL');
      return { kind: 'list', origin: list.origin, items: list.allItems, allItems: list.allItems };
    }
    case 'LIST_INVERT': {
      const list = requireList(args[0], 'LIST_INVERT');
      const activeNames = new Set(list.items.map((item) => item.name));
      return {
        kind: 'list',
        origin: list.origin,
        items: list.allItems.filter((item) => !activeNames.has(item.name)),
        allItems: list.allItems,
      };
    }
    case 'LIST_RANGE': {
      const list = requireList(args[0], 'LIST_RANGE');
      const min = listRangeBound(args[1], 'LIST_RANGE');
      const max = listRangeBound(args[2], 'LIST_RANGE');
      // Ink's native ListWithSubRange filters the list PASSED IN (its
      // own currently-active items), not the origin's full declared
      // universe — LIST_ALL/LIST_INVERT are what expose `allItems`.
      return {
        kind: 'list',
        origin: list.origin,
        items: list.items.filter((item) => item.ordinal >= min && item.ordinal <= max),
        allItems: list.allItems,
      };
    }
  }
}

/**
 * A function-knot call's handler — plain data in, plain data out, no
 * story-graph references baked in (see this file's header). Given the
 * called function's name, its ALREADY-EVALUATED argument values, and
 * the variable store at the call site, it must run that function to
 * completion and report back both its return value (the result the
 * call expression evaluates to) and the variable store afterward —
 * a function's body can mutate an outer-scope/global variable via a
 * plain `~ x = ...` (see expression-types.ts's `ReturnStatement` doc),
 * and that mutation has to be observable by whatever called `evaluate`/
 * `execute` in the first place, not silently dropped. Building one of
 * these from an actual story graph is function-interpreter.ts's job —
 * this file only defines the shape.
 */
export type CallFunctionHandler = (
  name: string,
  args: VariableValue[],
  variables: Record<string, VariableValue>,
) => { value: VariableValue; variables: Record<string, VariableValue> };

/**
 * Mutable carrier for "the variable store as of the last function
 * call we evaluated", threaded through one evaluation tree so a call
 * earlier in the same expression (`f(x) + g(x)`, left-to-right) is
 * visible to one evaluated later, and so the FINAL store (after every
 * call in the tree has run) can be reported back to whatever needs it
 * — see `evaluateWithEffects`. Never read `variables` captured in an
 * outer closure once `box.vars` exists; always go through the box.
 */
interface VariablesBox {
  vars: Record<string, VariableValue>;
}

function evaluateNode(
  expr: Expression,
  box: VariablesBox,
  callFunction: CallFunctionHandler | undefined,
): VariableValue {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'variable':
      if (!(expr.name in box.vars)) {
        throw new ExpressionEvaluationError(`Undefined variable: ${expr.name}`);
      }
      return box.vars[expr.name];
    case 'unary': {
      const operand = evaluateNode(expr.operand, box, callFunction);
      if (expr.operator === '-') {
        if (typeof operand !== 'number') {
          throw new ExpressionEvaluationError(`Cannot negate a ${typeof operand}`);
        }
        return -operand;
      }
      // '!'
      return !truthy(operand);
    }
    case 'binary':
      return evaluateBinary(
        expr.operator,
        evaluateNode(expr.left, box, callFunction),
        evaluateNode(expr.right, box, callFunction),
      );
    case 'logical': {
      const left = evaluateNode(expr.left, box, callFunction);
      // Short-circuit: the right side is only evaluated when it can
      // actually affect the result, matching every C-family language's
      // &&/|| and letting a condition like `count > 0 && 1/count > x`
      // guard the divide safely.
      if (expr.operator === '&&') {
        return truthy(left) ? truthy(evaluateNode(expr.right, box, callFunction)) : false;
      }
      return truthy(left) ? true : truthy(evaluateNode(expr.right, box, callFunction));
    }
    case 'listFunction':
      return evaluateListFunction(
        expr.name,
        expr.args.map((arg) => evaluateNode(arg, box, callFunction)),
      );
    case 'call': {
      if (!callFunction) {
        throw new ExpressionEvaluationError(
          `Cannot call '${expr.name}(...)': function calls require a callFunction handler, and none was provided`,
        );
      }
      const argValues = expr.args.map((arg) => evaluateNode(arg, box, callFunction));
      const result = callFunction(expr.name, argValues, box.vars);
      box.vars = result.variables;
      return result.value;
    }
  }
}

export function evaluate(
  expr: Expression,
  variables: Record<string, VariableValue>,
  callFunction?: CallFunctionHandler,
): VariableValue {
  return evaluateNode(expr, { vars: variables }, callFunction);
}

/**
 * Like `evaluate`, but also reports the variable store as it stood
 * after every function call in the tree ran — the piece plain
 * `evaluate` necessarily drops, since its signature only returns a
 * single value. Needed anywhere a call's side effect on a
 * global/outer-scope variable must actually persist — `execute`
 * (below) uses this for an assignment's right-hand side so `~ gold =
 * double(gold)` doesn't silently lose some OTHER global `double`
 * happened to touch along the way.
 *
 * A caller that only wants the value (most condition/conditional-text
 * checks) can keep calling plain `evaluate` — a function called
 * PURELY for a side effect from inside a condition won't have that
 * side effect observed through `evaluate`, which is a known,
 * documented limitation rather than an oversight (see this file's
 * header): threading a mutable store through every condition-checking
 * call site in the codebase is a much larger change than this pass
 * takes on.
 */
export function evaluateWithEffects(
  expr: Expression,
  variables: Record<string, VariableValue>,
  callFunction?: CallFunctionHandler,
): { value: VariableValue; variables: Record<string, VariableValue> } {
  const box: VariablesBox = { vars: variables };
  const value = evaluateNode(expr, box, callFunction);
  return { value, variables: box.vars };
}

/**
 * Apply a statement, returning a NEW variables map rather than
 * mutating the one passed in — callers (React state setters, backend
 * validation walking a sequence of statements) can rely on the input
 * being untouched.
 *
 * A bare `return` statement (function-knots — DEV-199 Phase 10b) has
 * no effect here: `execute` just walks assignments, and `return`'s
 * actual meaning (stop walking a function's content, capture a value)
 * only exists inside function-interpreter.ts's knot walker. Treating
 * it as a no-op means any EXISTING content walker that doesn't know
 * about function-knots yet (and never will — see this file's header)
 * doesn't crash if a ReturnStatement ever reaches it.
 */
export function execute(
  stmt: Statement,
  variables: Record<string, VariableValue>,
  callFunction?: CallFunctionHandler,
): Record<string, VariableValue> {
  if (stmt.kind === 'return') {
    return variables;
  }
  return executeAssignment(stmt, variables, callFunction);
}

function executeAssignment(
  stmt: AssignmentStatement,
  variables: Record<string, VariableValue>,
  callFunction: CallFunctionHandler | undefined,
): Record<string, VariableValue> {
  const { value: rhs, variables: afterRhs } = evaluateWithEffects(
    stmt.value,
    variables,
    callFunction,
  );
  if (stmt.operator === '=') {
    return { ...afterRhs, [stmt.name]: rhs };
  }
  if (!(stmt.name in afterRhs)) {
    throw new ExpressionEvaluationError(
      `Cannot compound-assign to undefined variable: ${stmt.name}`,
    );
  }
  // '+=' -> '+', '-=' -> '-', etc.
  const baseOperator = stmt.operator.slice(0, -1) as BinaryOperator;
  const next = evaluateBinary(baseOperator, afterRhs[stmt.name], rhs);
  return { ...afterRhs, [stmt.name]: next };
}
