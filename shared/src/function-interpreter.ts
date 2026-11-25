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
  // The TRUE global store — a single object shared across an entire
  // top-level call and everything it nests, updated INCREMENTALLY
  // (via `publish` below) as soon as any call writes a non-parameter
  // name, not just once each call finishes. Nested calls build their
  // own local scope from this, never from the `variables` argument
  // the evaluator happens to hand them (which — see `evaluateNode`'s
  // `case 'call'` — is really the ENCLOSING call's own local scope,
  // parameters and all; Ink has no closures, so a nested call must
  // never see an enclosing call's parameters as if they were
  // globals). Re-snapshotted fresh at the top of every top-level call
  // (depth 0), since that's the only point `variables` is guaranteed
  // to already be true globals.
  let globals: Record<string, VariableValue> = Object.create(null);

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
    const paramNames = new Set(params);
    // What `globals` looked like the MOMENT this call started —
    // compared against in `publish` below, rather than the live
    // (shared, ever-mutating) `globals`, so a key changes "during
    // this call" relative to a fixed baseline, not relative to
    // whatever a NESTED call already wrote it to. Without this fixed
    // baseline: a call that merely READS a global (never writes it)
    // looks unchanged against the live `globals` and correctly isn't
    // touched, which is right in isolation — but the same live-vs-
    // live comparison also made an ENCLOSING call miss a change a
    // NESTED call made on its behalf, if that nested call had
    // already brought `globals` in sync with the enclosing call's own
    // local value by the time the enclosing call checked (found in
    // review, in both directions).
    const startGlobals = Object.assign(Object.create(null), globals);
    // Exactly the keys THIS call's execution changed — not "all of
    // globals", which would overlay even names this call never
    // touched onto the caller's view, clobbering the caller's OWN
    // same-named parameter for no reason.
    const touched = new Set<string>();
    const publish = (store: Record<string, VariableValue>) => {
      for (const key of Object.keys(store)) {
        if (paramNames.has(key)) continue;
        if (Object.hasOwn(startGlobals, key) && startGlobals[key] === store[key]) continue;
        globals[key] = store[key];
        touched.add(key);
      }
    };

    depth++;
    try {
      // Object.assign(Object.create(null), ...) rather than a `{...}`
      // spread: a plain `{}` reintroduces Object.prototype, so a
      // parameter literally named `__proto__` would bind through the
      // inherited setter instead of becoming an own property.
      let local: Record<string, VariableValue> = Object.assign(Object.create(null), globals);
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
        // Published immediately, not batched until this call returns
        // — a LATER statement's nested call (or the caller, the
        // instant this call returns) must see an EARLIER statement's
        // global write right away, not a stale pre-call snapshot.
        publish(local);
      }
      // Catches a return expression's own nested-call effects, which
      // the loop's per-statement publish above doesn't reach.
      publish(local);

      // The value THIS call hands back to whatever called it: ONLY
      // the keys this call actually touched, overlaid onto the
      // caller's own incoming view — preserving whatever the
      // caller's own currently-bound parameters/locals already were,
      // even when one happens to share a name with something this
      // call touched (found in review: overlaying ALL of `globals`
      // here, rather than just this call's own touched keys, let an
      // untouched real global of the same name as this call's OWN
      // parameter either vanish from the merged view, or — the other
      // direction — clobber the CALLER's own shadowed parameter of
      // that name with a global value the callee never actually
      // wrote).
      const mergedVariables = Object.assign(Object.create(null), variables);
      for (const key of touched) mergedVariables[key] = globals[key];

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
    }
  };

  return caller;
}
