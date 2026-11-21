/**
 * Variable-conditioned audio: a simple `{variable, operator, value}`
 * comparison built from UI dropdowns (never typed as expression
 * syntax) that gates which audio file plays for a slot
 * (voiceover/ambience/choice1/choice2/sfx) on a passage. Translates
 * into the existing canonical `Expression` AST so it runs through the
 * same `evaluate()` every other condition in the app already uses
 * (`Choice.condition`/`TextBlock.condition`) — no separate evaluator.
 *
 * Deliberately narrower than `BinaryOperator`: arithmetic operators
 * (`+`/`-`/`*`/`/`/`%`) make no sense as a comparison, so they're
 * excluded at the type level rather than merely by convention.
 */

import type { Expression, VariableValue } from './expression-types.js';
import { evaluate } from './expression-evaluator.js';

export type ComparisonOperator = '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface SimpleCondition {
  variable: string;
  operator: ComparisonOperator;
  value: VariableValue;
}

export function simpleConditionToExpression(condition: SimpleCondition): Expression {
  return {
    kind: 'binary',
    operator: condition.operator,
    left: { kind: 'variable', name: condition.variable },
    right: { kind: 'literal', value: condition.value },
  };
}

/**
 * Evaluate a condition against live variable state. Returns `false`
 * (rather than throwing) when the referenced variable doesn't exist —
 * an audio slot gated on a variable that isn't declared yet should
 * stay silent, not crash playback, matching how an unresolved
 * `Choice.condition`/`TextBlock.condition` already degrades elsewhere
 * in the player.
 */
export function evaluateSimpleCondition(
  condition: SimpleCondition,
  variables: Record<string, VariableValue>,
): boolean {
  try {
    return Boolean(evaluate(simpleConditionToExpression(condition), variables));
  } catch {
    return false;
  }
}
