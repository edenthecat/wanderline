import { createVariableState, declareVariableIfNew } from '../twee-content.js';
import type { Expression, ListValue, ValidationMessage } from '../../types.js';

// DEV-199 Phase 10: no Twee dialect parses LIST syntax today, but
// declareVariableIfNew's type-inference ternary should still match
// its ink-parser.ts sibling (parseVariableDeclarationLine) so a
// future list-valued initializer (or a shared evaluator change) is
// typed correctly instead of silently mistyped as 'string'.
describe('declareVariableIfNew', () => {
  it('infers type "list" when the initial value evaluates to a ListValue', () => {
    const state = createVariableState();
    const warnings: ValidationMessage[] = [];
    const listValue: ListValue = {
      kind: 'list',
      origin: 'kettleState',
      items: [{ name: 'boiling', ordinal: 1 }],
      allItems: [
        { name: 'cold', ordinal: 0 },
        { name: 'boiling', ordinal: 1 },
      ],
    };
    const initialValue: Expression = { kind: 'literal', value: 'unused' };
    declareVariableIfNew('kettleState', initialValue, state, () => listValue, warnings, 1);
    expect(state.variables).toEqual([
      {
        name: 'kettleState',
        type: 'list',
        initialValue,
        isConst: false,
        listMembers: ['cold', 'boiling'],
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it('still infers number/bool/string correctly for non-LIST values', () => {
    const state = createVariableState();
    const warnings: ValidationMessage[] = [];
    declareVariableIfNew('gold', { kind: 'literal', value: 5 }, state, () => 5, warnings, 1);
    expect(state.variables).toEqual([
      { name: 'gold', type: 'number', initialValue: { kind: 'literal', value: 5 }, isConst: false },
    ]);
  });
});
