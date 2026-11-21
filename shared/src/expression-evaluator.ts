/**
 * Pure evaluator for the canonical expression AST (expression-types.ts).
 * No I/O, no story-graph knowledge — `evaluate`/`execute` just need a
 * `name -> value` map. Shared verbatim between backend (parse-time
 * validation, preview) and player-app (runtime playback) so a
 * condition can never evaluate differently in the editor than it does
 * during playback.
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

export function evaluate(
  expr: Expression,
  variables: Record<string, VariableValue>,
): VariableValue {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'variable':
      if (!(expr.name in variables)) {
        throw new ExpressionEvaluationError(`Undefined variable: ${expr.name}`);
      }
      return variables[expr.name];
    case 'unary': {
      const operand = evaluate(expr.operand, variables);
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
        evaluate(expr.left, variables),
        evaluate(expr.right, variables),
      );
    case 'logical': {
      const left = evaluate(expr.left, variables);
      // Short-circuit: the right side is only evaluated when it can
      // actually affect the result, matching every C-family language's
      // &&/|| and letting a condition like `count > 0 && 1/count > x`
      // guard the divide safely.
      if (expr.operator === '&&') {
        return truthy(left) ? truthy(evaluate(expr.right, variables)) : false;
      }
      return truthy(left) ? true : truthy(evaluate(expr.right, variables));
    }
    case 'listFunction':
      return evaluateListFunction(
        expr.name,
        expr.args.map((arg) => evaluate(arg, variables)),
      );
  }
}

/**
 * Apply a statement, returning a NEW variables map rather than
 * mutating the one passed in — callers (React state setters, backend
 * validation walking a sequence of statements) can rely on the input
 * being untouched.
 */
export function execute(
  stmt: Statement,
  variables: Record<string, VariableValue>,
): Record<string, VariableValue> {
  return executeAssignment(stmt, variables);
}

function executeAssignment(
  stmt: AssignmentStatement,
  variables: Record<string, VariableValue>,
): Record<string, VariableValue> {
  const rhs = evaluate(stmt.value, variables);
  if (stmt.operator === '=') {
    return { ...variables, [stmt.name]: rhs };
  }
  if (!(stmt.name in variables)) {
    throw new ExpressionEvaluationError(
      `Cannot compound-assign to undefined variable: ${stmt.name}`,
    );
  }
  // '+=' -> '+', '-=' -> '-', etc.
  const baseOperator = stmt.operator.slice(0, -1) as BinaryOperator;
  const next = evaluateBinary(baseOperator, variables[stmt.name], rhs);
  return { ...variables, [stmt.name]: next };
}
