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
 */
export function conditionAllows(
  condition: Expression | null | undefined,
  variables: Record<string, VariableValue>,
): boolean {
  if (!condition) return true;
  try {
    return truthy(evaluate(condition, variables));
  } catch {
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
): string {
  const transcript = node.metadata?.transcript?.trim();
  if (transcript) return transcript;
  return node.content
    .filter(isTextBlock)
    .filter((c) => conditionAllows(c.condition, variables))
    .map((c) => c.text)
    .join(' ')
    .trim();
}
