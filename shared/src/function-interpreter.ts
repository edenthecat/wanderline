/**
 * Builds the `CallFunctionHandler` (expression-evaluator.ts) that
 * actually RUNS an Ink function-knot (DEV-199 Phase 10b —
 * `=== function foo(x) === ... ~ return x * 2`), given a way to look
 * up a function-knot's definition by name. Shared between backend
 * (parse-time validation/preview) and player-app (real playback) so a
 * function call behaves IDENTICALLY in both — the same contract the
 * rest of the evaluator module already has for every other
 * expression kind.
 *
 * Deliberately scoped OUT of this pass (see the project's tracking
 * notes — "DEV-199 Phase 10b"):
 *
 *  - `ref` parameters (Ink's by-reference params, letting a function
 *    mutate a variable in the CALLER's own scope under a different
 *    name than its own). Nothing here rejects a `ref` parameter
 *    itself — ink-parser.ts strips the `ref` keyword at parse time
 *    and warns that it's being treated as a plain by-value parameter
 *    — but no alias-to-caller-scope behavior is implemented.
 *  - A trailing divert-target parameter used as a tail-exit (Ink
 *    allows a function to divert elsewhere as its last act instead of
 *    `return`ing). Not recognized at all; a function-knot's content
 *    is assumed to contain only plain-value statements.
 *  - `temp` locals inside a function body. This codebase's Ink
 *    parser doesn't recognize the `temp` keyword anywhere (not just
 *    inside functions), so an assignment to a name that is neither a
 *    global variable nor one of this call's own parameters creates a
 *    new GLOBAL as a side effect of the call — not scoped to the call
 *    the way a real `temp` would be. Pre-existing limitation of this
 *    codebase's assignment statements generally, not something this
 *    module introduces.
 *  - Multi-line Ink conditional blocks (`{cond:\n ... \n- else:\n
 *    ...\n}`) for branching a function's return value. This parser
 *    has never supported Ink's multi-line weave/conditional-block
 *    syntax (only the single-line `{cond: text}` form) for ANY knot,
 *    function or otherwise — so a function body here is just a flat
 *    sequence of plain assignment/return statements, no branching.
 */

import {
  evaluateWithEffects,
  execute,
  ExpressionEvaluationError,
  type CallFunctionHandler,
} from './expression-evaluator.js';
import type { ContentBlock, VariableValue } from './expression-types.js';

/**
 * The minimal shape this interpreter needs from "a function-knot's
 * node" — deliberately NOT StoryNode/StoryGraph (backend's and the
 * player's own node shapes genuinely diverge beyond this), so this
 * file stays usable from both without either depending on the
 * other's types.
 */
export interface FunctionKnotLike {
  /** Parameter names, in declaration order. Absent/empty means the
   * function takes no arguments. */
  params?: string[];
  content: ContentBlock[];
}

/** How deep a chain of function calls (recursive or otherwise) may
 * nest before this module gives up and reports an error, rather than
 * recursing until the host JS engine's own call stack overflows with
 * a much less legible error. 100 comfortably covers any
 * non-pathological story; a function recursing that deep on purpose
 * is almost certainly an authoring bug (infinite/unbounded
 * recursion), which is exactly the case this guard exists to catch
 * instead of hanging the editor or the player. */
export const MAX_FUNCTION_CALL_DEPTH = 100;

export interface FunctionCallerOptions {
  /** Look up a function-knot's definition by name. `undefined` means
   * "no such function" — the caller reports this as a clear error
   * rather than crashing on a missing node. */
  getFunction: (name: string) => FunctionKnotLike | undefined;
}

/**
 * Build a `CallFunctionHandler` backed by real function-knots. The
 * returned handler is stateful ONLY in its call-depth counter (reset
 * to 0 between top-level calls via try/finally) — it does not cache
 * or mutate anything about the story itself, so a single instance can
 * safely be reused across an entire playthrough/validation pass.
 */
export function createFunctionCaller(options: FunctionCallerOptions): CallFunctionHandler {
  let depth = 0;
  // The TRUE global store, captured fresh at the top of every TOP-
  // LEVEL call (depth 0) — the only point at which the incoming
  // `variables` argument is guaranteed to be actual globals, not an
  // enclosing call's own LOCAL scope. `evaluateNode`'s `case 'call'`
  // passes `box.vars` as `variables` on every call, nested or not —
  // for a call made from INSIDE a function body, `box.vars` there is
  // that function's `local` (globals plus its own bound parameters),
  // not the story's real globals. Ink has no closures: a nested call
  // must only ever see true globals, never an enclosing call's
  // parameters (found in review — with global `x = 100`, `outer(x)`
  // returning `readGlobal()`, and `readGlobal()` returning bare `x`,
  // `outer(1)` was returning 1, outer's OWN bound parameter, instead
  // of 100, the real global of the same name). Every call, at any
  // depth, builds its own local scope from this snapshot — updated as
  // each call's global-level effects are merged back below — rather
  // than from whatever `variables` this particular invocation happens
  // to receive.
  let globals: Record<string, VariableValue> | null = null;

  const caller: CallFunctionHandler = (name, args, variables) => {
    const fn = options.getFunction(name);
    if (!fn) {
      throw new ExpressionEvaluationError(`Call to undeclared function '${name}'`);
    }
    const params = fn.params ?? [];
    if (params.length !== args.length) {
      throw new ExpressionEvaluationError(
        `Function '${name}' expects ${params.length} argument(s) but was called with ${args.length}`,
      );
    }
    if (depth >= MAX_FUNCTION_CALL_DEPTH) {
      throw new ExpressionEvaluationError(
        `Function call depth exceeded ${MAX_FUNCTION_CALL_DEPTH} (likely unbounded recursion calling '${name}')`,
      );
    }
    if (depth === 0) {
      globals = Object.assign(Object.create(null), variables);
    }
    const trueGlobals = globals as Record<string, VariableValue>;

    depth++;
    try {
      // Local scope: a copy of the TRUE globals (not the possibly
      // locals-contaminated incoming `variables` — see above), with
      // each parameter bound positionally. A parameter whose name
      // shadows an existing global is intentional — Ink scopes
      // parameters lexically to the call, see this module's header
      // re: `ref` — and is undone below before merging back out.
      // Object.assign(Object.create(null), ...) rather than a `{...}`
      // spread: a plain `{}` reintroduces Object.prototype, so a
      // legal parameter literally named `__proto__` would bind
      // through the inherited setter instead of becoming an own
      // property — a function returning that parameter would then
      // return Object.prototype itself, not its argument (found in
      // review).
      let local: Record<string, VariableValue> = Object.assign(Object.create(null), trueGlobals);
      params.forEach((paramName, i) => {
        local[paramName] = args[i];
      });

      let returnValue: VariableValue | undefined;
      for (const block of fn.content) {
        if (block.kind !== 'assignment') {
          // A TextBlock — narration/text inside a function body.
          // Real Ink interpolates a function's own printed text into
          // the call site's string result; this module doesn't (see
          // header) — only `return` ever produces a value here.
          continue;
        }
        if (block.statement.kind === 'return') {
          if (block.statement.value) {
            // evaluateWithEffects (not plain evaluate): the returned
            // EXPRESSION can itself contain a nested call
            // (`~ return helper(x)`) whose side effect on some OTHER
            // global must still be merged back out below — using
            // plain `evaluate` here would silently drop it, the same
            // bug this module exists to avoid at the top level.
            const result = evaluateWithEffects(block.statement.value, local, caller);
            returnValue = result.value;
            local = result.variables;
          } else {
            returnValue = undefined;
          }
          break;
        }
        local = execute(block.statement, local, caller);
      }

      // This call's global-level effects: `local` minus its own
      // parameter names — a parameter is local to the call (no
      // `ref`, see header), so it must not leak out and clobber (or
      // fabricate) a same-named global. Becomes the new snapshot
      // every OTHER call (sibling or enclosing) sees from here on.
      const paramNames = new Set(params);
      const globalEffects: Record<string, VariableValue> = Object.create(null);
      for (const [key, value] of Object.entries(local)) {
        if (!paramNames.has(key)) globalEffects[key] = value;
      }
      globals = globalEffects;

      // The value THIS call hands back to whatever called it: the
      // global effects layered onto the CALLER's own incoming view
      // (preserving whatever the caller's own currently-bound
      // parameters/locals already were — losing those would break
      // the caller's own subsequent evaluation, not just globals).
      const mergedVariables = Object.assign(Object.create(null), variables, globalEffects);

      // No `return` statement ran: the call is being used for its
      // value despite being written purely for side effects. Rather
      // than widen VariableValue to include `undefined` (a much
      // larger change rippling through every other expression kind),
      // this resolves to the empty string — falsy, inert in string
      // concatenation, and distinguishable from a real returned value
      // in a debugger without crashing the evaluator.
      return { value: returnValue ?? '', variables: mergedVariables };
    } finally {
      depth--;
      if (depth === 0) globals = null;
    }
  };

  return caller;
}
