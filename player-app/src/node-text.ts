// Pulled out of App.tsx so useMediaControls.ts (which App.tsx itself
// imports) can use the SAME condition-filtered text App.tsx uses for
// on-screen/narrated display, without an import cycle (App.tsx ->
// useMediaControls.ts -> App.tsx). App.tsx re-exports both names so
// every existing `import { nodeText, conditionAllows } from './App'`
// call site keeps working unchanged.

import {
  isTextBlock,
  evaluate,
  truthy,
  type CallFunctionHandler,
  type ContentBlock,
  type Expression,
  type VariableValue,
} from '@wanderline/shared';

/**
 * Whether a conditional block (DEV-199 Phase 3: text; Phase 4:
 * choices) should show, given the current variable store. No
 * condition at all always shows. A condition that fails to evaluate
 * (references a variable that was renamed/removed since the story was
 * authored) is treated as false — hidden, not shown-with-a-crash and
 * not shown-unconditionally, the same tolerant-degradation choice as
 * applyNodeAssignments in App.tsx.
 *
 * `callFunction` (DEV-199 Phase 10b) is optional and passed through
 * to `evaluate` unchanged — see expression-evaluator.ts's header for
 * why a condition that calls a function PURELY for a side effect
 * won't have that side effect persist through this path (a documented
 * limitation, not a bug): this function only ever returns a boolean,
 * so there's nowhere to hand back a mutated variable store even if it
 * computed one internally.
 */
export function conditionAllows(
  condition: Expression | null | undefined,
  variables: Record<string, VariableValue>,
  callFunction?: CallFunctionHandler,
): boolean {
  if (!condition) return true;
  try {
    return truthy(evaluate(condition, variables, callFunction));
  } catch (err) {
    // Logged (unlike the pre-function-knots version of this catch)
    // because a function-call error here — undeclared function,
    // depth exceeded, bad arity, an undefined variable inside the
    // function body — is otherwise indistinguishable from an
    // intentionally-gated choice/text block, with no console signal
    // that the condition actually failed to evaluate at all.
    console.warn('[wanderline] condition failed to evaluate', { condition, err });
    return false;
  }
}

/** The passage as text: an explicit transcript wins, otherwise the
 * Ink content lines joined — skipping any text block whose condition
 * (DEV-199 Phase 3) doesn't hold against the current variable store. */
export function nodeText(
  node: {
    content: ContentBlock[];
    metadata?: { transcript?: string | null };
  },
  variables: Record<string, VariableValue> = {},
  callFunction?: CallFunctionHandler,
): string {
  const transcript = node.metadata?.transcript?.trim();
  if (transcript) return transcript;
  return node.content
    .filter(isTextBlock)
    .filter((c) => conditionAllows(c.condition, variables, callFunction))
    .map((c) => c.text)
    .join(' ')
    .trim();
}
