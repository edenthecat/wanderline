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

/** De-duplicated by name — a union/difference result never carries
 * the same member twice, regardless of how many origins contributed
 * to it. */
function dedupeItems(items: ListItem[]): ListItem[] {
  const byName = new Map<string, ListItem>();
  for (const item of items) byName.set(item.name, item);
  return [...byName.values()];
}

function listUnion(a: ListValue, b: ListValue): ListValue {
  return {
    kind: 'list',
    origin: a.origin,
    items: dedupeItems([...a.items, ...b.items]),
    allItems: a.allItems,
  };
}

function listDifference(a: ListValue, b: ListValue): ListValue {
  const removeNames = new Set(b.items.map((item) => item.name));
  return {
    kind: 'list',
    origin: a.origin,
    items: a.items.filter((i) => !removeNames.has(i.name)),
    allItems: a.allItems,
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
 * not a lexicographic/length comparison): `a < b` iff every item in
 * `a` sits before every item in `b` in their shared declaration
 * order — i.e. a's MAXIMUM ordinal is less than b's MINIMUM. `a > b`
 * is the mirror: a's minimum exceeds b's maximum. An empty list has
 * no max/min, so it never compares true either way — matching Ink's
 * own behavior rather than crashing on `Math.max()` of nothing.
 */
function listCompare(operator: '<' | '<=' | '>' | '>=', a: ListValue, b: ListValue): boolean {
  if (a.items.length === 0 || b.items.length === 0) return false;
  const aOrdinals = a.items.map((item) => item.ordinal);
  const bOrdinals = b.items.map((item) => item.ordinal);
  const aMax = Math.max(...aOrdinals);
  const aMin = Math.min(...aOrdinals);
  const bMax = Math.max(...bOrdinals);
  const bMin = Math.min(...bOrdinals);
  switch (operator) {
    case '<':
      return aMax < bMin;
    case '<=':
      return aMax <= bMin;
    case '>':
      return aMin > bMax;
    case '>=':
      return aMin >= bMax;
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
      const list = requireList(args[0], 'LIST_VALUE');
      return list.items.length > 0 ? Math.min(...list.items.map((item) => item.ordinal)) : 0;
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
      return {
        kind: 'list',
        origin: list.origin,
        items: list.allItems.filter((item) => item.ordinal >= min && item.ordinal <= max),
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
