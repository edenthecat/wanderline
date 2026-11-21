import { describe, it, expect } from 'vitest';
import {
  simpleConditionToExpression,
  evaluateSimpleCondition,
  type SimpleCondition,
} from '@wanderline/shared';

// Variable-conditioned audio: the simple {variable, operator, value}
// condition built from UI dropdowns, translated into the canonical
// Expression AST and run through the existing shared evaluate() —
// these tests pin that translation + evaluation pipeline, since
// player-app's audio-variant resolver only as correct as this file.

describe('simpleConditionToExpression', () => {
  it('builds a binary comparison expression from the condition triple', () => {
    const condition: SimpleCondition = { variable: 'gold', operator: '>', value: 10 };
    expect(simpleConditionToExpression(condition)).toEqual({
      kind: 'binary',
      operator: '>',
      left: { kind: 'variable', name: 'gold' },
      right: { kind: 'literal', value: 10 },
    });
  });
});

describe('evaluateSimpleCondition', () => {
  it('evaluates true/false against live variable state', () => {
    expect(
      evaluateSimpleCondition({ variable: 'gold', operator: '>', value: 10 }, { gold: 15 }),
    ).toBe(true);
    expect(
      evaluateSimpleCondition({ variable: 'gold', operator: '>', value: 10 }, { gold: 5 }),
    ).toBe(false);
  });

  it('works with string and boolean values, not just numbers', () => {
    expect(
      evaluateSimpleCondition(
        { variable: 'mood', operator: '==', value: 'angry' },
        { mood: 'angry' },
      ),
    ).toBe(true);
    expect(
      evaluateSimpleCondition(
        { variable: 'hasKey', operator: '==', value: true },
        { hasKey: true },
      ),
    ).toBe(true);
    expect(
      evaluateSimpleCondition(
        { variable: 'hasKey', operator: '==', value: true },
        { hasKey: false },
      ),
    ).toBe(false);
  });

  it('returns false (not a throw) when the variable is not declared', () => {
    expect(evaluateSimpleCondition({ variable: 'missing', operator: '==', value: 1 }, {})).toBe(
      false,
    );
  });
});
