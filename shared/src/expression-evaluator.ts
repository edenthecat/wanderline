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
  Statement,
  VariableValue,
} from './expression-types.js';

export class ExpressionEvaluationError extends Error {}

function truthy(value: VariableValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value.length > 0;
}

function evaluateBinary(
  operator: BinaryOperator,
  left: VariableValue,
  right: VariableValue,
): VariableValue {
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
