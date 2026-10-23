/**
 * Harlowe macro translation (DEV-199 Phase 7).
 *
 * Harlowe is Twine's default story format. This module translates its
 * native macro/expression syntax into the canonical Expression/
 * Statement AST (shared/src/expression-*.ts) that every dialect (and
 * Ink) compiles into — see twee-parser.ts's module doc and the
 * variable-support plan's architecture note. twee-parser.ts calls
 * into this module only when the detected dialect (DEV-199 Phase 6)
 * is 'harlowe'; the other two dialects get their own sibling modules
 * (sugarcube-macros.ts, chapbook-macros.ts).
 *
 * Supported subset (v1):
 *   - `(set: $x to EXPR)` / `(put: EXPR into $x)`, including multiple
 *     comma-separated assignments in one macro call. Harlowe has no
 *     separate declaration syntax — the first `(set:)`/`(put:)` for a
 *     given $-variable anywhere in the story implicitly declares it
 *     (StoryGraph.variables), mirroring how ink-parser.ts infers a
 *     VAR's type from its initializer.
 *   - `(if: EXPR)[TEXT]`, as an entire content paragraph → a
 *     conditional TextBlock.
 *   - `(if: EXPR)[[[Link]]]` (a Twee link — itself `[[...]]` — inside
 *     an if-hook's own `[...]` wrapper, hence the three brackets each
 *     side) → a conditional Choice, flattening the wrapping condition
 *     onto it — the block-flattening the plan's architecture section
 *     describes for all three Twine dialects.
 *   - Expression syntax: `$name` variables (sigil stripped), `is` /
 *     `is not` (→ `==`/`!=`), `and`/`or`/`not` (→ `&&`/`||`/`!`),
 *     numeric and single- OR double-quoted string literals, parens,
 *     and the arithmetic/comparison operators the canonical grammar
 *     already shares the symbols for.
 *
 * Deliberately out of scope for v1 (left exactly as inert text, same
 * as every Twee macro was before this phase):
 *   - `(else:)` / `(else-if:)` chains.
 *   - Temp variables (`_name`).
 *   - Any other Harlowe macro — (link:), (display:), (goto:), arrays,
 *     datamaps, etc.
 */

import { parseExpression } from '@wanderline/shared';
import type {
  ContentBlock,
  Choice,
  Expression,
  Statement,
  ValidationMessage,
  VariableValue,
} from '../types.js';
import {
  extractLinks,
  bodyToContent,
  readQuotedLiteral,
  escapeDoubleQuoted,
  declareVariableIfNew,
  type DialectVariableState,
} from './twee-content.js';

/**
 * Scan forward from `start` (which must index the opening
 * `open` character) and return the index ONE PAST the matching
 * `close`, respecting nesting and skipping over quoted strings (so a
 * `)` or `]` inside a string literal can't prematurely close the
 * macro/hook). Returns -1 when the brackets never balance.
 */
function matchBalanced(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Split `text` on top-level occurrences of `separator` (a single
 * character) — one not nested inside `()`, `[]`, or a quoted string.
 * Used to split `(set: $x to 1, $y to 2)`'s argument list on commas
 * without being fooled by a comma inside, say, a string literal or a
 * parenthesised sub-expression.
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      current += ch;
      while (j < text.length && text[j] !== quote) {
        current += text[j];
        if (text[j] === '\\' && j + 1 < text.length) {
          current += text[j + 1];
          j += 2;
          continue;
        }
        j++;
      }
      if (j < text.length) {
        current += text[j];
        j++;
      }
      i = j;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  parts.push(current);
  return parts;
}

/**
 * Translate Harlowe expression syntax into the canonical textual
 * surface expression-parser.ts understands. Tokenizes just enough to
 * respect quoted strings — a naive whole-string regex would mangle a
 * string literal that happens to contain the word "and" or "is" (e.g.
 * `$name is "Andrea"`) or a stray `$` sign.
 */
// Longest-first so "is not" matches before the bare "is" rule would
// split it wrong.
function translateWordOperators(text: string): string {
  return text
    .replace(/\bis\s+not\b/gi, '!=')
    .replace(/\bis\b/gi, '==')
    .replace(/\band\b/gi, '&&')
    .replace(/\bor\b/gi, '||')
    .replace(/\bnot\b\s*/gi, '!');
}

export function translateHarloweExpression(source: string): string {
  let out = '';
  let plainBuffer = '';
  let i = 0;

  // Word-operator translation only ever runs on `plainBuffer` — text
  // that is neither inside a quoted string nor a sigil-stripped
  // identifier. Flushing BEFORE appending a string/identifier to
  // `out` keeps those two kinds of content from ever being run
  // through the operator regexes themselves: a string literal like
  // "this is cool" must keep its "is", and a variable named $is must
  // keep its name, not become "==".
  const flushPlain = () => {
    if (plainBuffer) {
      out += translateWordOperators(plainBuffer);
      plainBuffer = '';
    }
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      // Re-quote with the canonical grammar's double-quote-only
      // rules. Unescape relative to the ORIGINAL quote character
      // first, then re-escape relative to double quotes — a blind
      // backslash-forward copy would double-escape a `\'` from a
      // single-quoted source string.
      flushPlain();
      const { value, end } = readQuotedLiteral(source, i);
      out += `"${escapeDoubleQuoted(value)}"`;
      i = end;
      continue;
    }
    if (ch === '$') {
      // Sigil strip: $name -> name. Harlowe identifiers are
      // [A-Za-z_][A-Za-z0-9_]*, same as the canonical grammar's.
      flushPlain();
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      out += source.slice(i + 1, j);
      i = j;
      continue;
    }
    plainBuffer += ch;
    i++;
  }
  flushPlain();
  return out;
}

/**
 * Render a canonical Expression back into Harlowe syntax — the
 * reverse of translateHarloweExpression, used by twee-emitter.ts.
 * Walks the AST directly (rather than printing canonical text and
 * regex-transforming it) specifically so a boolean literal's bare
 * `true`/`false` can never be mistaken for a variable reference and
 * get a `$` sigil it shouldn't.
 *
 * Every binary/logical child is UNCONDITIONALLY wrapped in parens,
 * rather than replicating expression-parser.ts's minimal-parens
 * precedence logic for Harlowe's own (different) operator set — an
 * extra paren never changes meaning, so this trades slightly noisier
 * output for not having to re-derive Harlowe's precedence table.
 */
export function renderHarloweExpression(expr: Expression): string {
  switch (expr.kind) {
    case 'literal':
      if (typeof expr.value === 'string') {
        return `"${escapeDoubleQuoted(expr.value)}"`;
      }
      return String(expr.value);
    case 'variable':
      return `$${expr.name}`;
    case 'unary': {
      const operand = renderHarloweExpression(expr.operand);
      return expr.operator === '!' ? `not (${operand})` : `-(${operand})`;
    }
    case 'binary': {
      const left = renderHarloweExpression(expr.left);
      const right = renderHarloweExpression(expr.right);
      if (expr.operator === '==') return `(${left}) is (${right})`;
      if (expr.operator === '!=') return `(${left}) is not (${right})`;
      return `(${left}) ${expr.operator} (${right})`;
    }
    case 'logical': {
      const left = renderHarloweExpression(expr.left);
      const right = renderHarloweExpression(expr.right);
      return `(${left}) ${expr.operator === '&&' ? 'and' : 'or'} (${right})`;
    }
  }
}

/**
 * Render a canonical assignment Statement back into a `(set: ...)`
 * macro call — used by twee-emitter.ts. Always emits `set` (not
 * `put`) and the `=` form (not `+=`/etc, which Harlowe's (set:)
 * doesn't support directly) by expanding a compound assignment into
 * `$name to $name <op> value` — e.g. `gold += 10` becomes
 * `(set: $gold to $gold + 10)`. Semantically identical; Harlowe has
 * no compound-assignment macro shorthand to re-emit into instead.
 */
export function renderHarloweAssignment(statement: Statement): string {
  const target = `$${statement.name}`;
  if (statement.operator === '=') {
    return `(set: ${target} to ${renderHarloweExpression(statement.value)})`;
  }
  const baseOperator = statement.operator.slice(0, -1);
  return `(set: ${target} to (${target}) ${baseOperator} (${renderHarloweExpression(statement.value)}))`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One parsed `name <- EXPR` pair from inside a (set:)/(put:) macro's
 * argument list, before being turned into a Statement. */
interface ParsedAssignment {
  name: string;
  value: Expression;
}

const SET_ASSIGNMENT_RE = /^\s*\$([A-Za-z_][A-Za-z0-9_]*)\s+to\s+(.+)$/i;
const PUT_ASSIGNMENT_RE = /^\s*(.+?)\s+into\s+\$([A-Za-z_][A-Za-z0-9_]*)\s*$/i;

function parseSetOrPutArgs(
  kind: 'set' | 'put',
  argsText: string,
  warnings: ValidationMessage[],
  lineNumber: number,
): ParsedAssignment[] {
  const parts = splitTopLevel(argsText, ',');
  const result: ParsedAssignment[] = [];
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = kind === 'set' ? part.match(SET_ASSIGNMENT_RE) : part.match(PUT_ASSIGNMENT_RE);
    if (!match) {
      warnings.push({
        type: 'syntax_error',
        message: `Could not parse (${kind}:) argument "${part}" — expected ${
          kind === 'set' ? '$name to EXPR' : 'EXPR into $name'
        }.`,
        lineNumber,
      });
      continue;
    }
    const name = kind === 'set' ? match[1] : match[2];
    const exprSource = kind === 'set' ? match[2] : match[1];
    try {
      const value = parseExpression(translateHarloweExpression(exprSource));
      result.push({ name, value });
    } catch (err) {
      warnings.push({
        type: 'syntax_error',
        message: `Could not parse the value in (${kind}: ${part}): ${errorMessage(err)}`,
        lineNumber,
      });
    }
  }
  return result;
}

/** A macro call found in passage text: its name, the raw text of its
 * `(...)` argument list, and the [start, end) span of the WHOLE
 * `(macro: args)` text (not including a following hook, if any). */
interface MacroCall {
  name: string;
  argsText: string;
  start: number;
  end: number;
}

const MACRO_START_RE = /\(([a-z][a-z0-9-]*)\s*:/gi;

/** Find every top-level `(name: ...)` macro call in `text`. Doesn't
 * descend into a macro's own arguments looking for nested macros —
 * v1 only ever needs to recognize set/put/if at the top level of a
 * passage's content. */
function findMacroCalls(text: string): MacroCall[] {
  const calls: MacroCall[] = [];
  const re = new RegExp(MACRO_START_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    // match.index is the position of the matched `(` itself — the
    // regex is anchored to start there, so no offset is needed to
    // find it. (An earlier version computed this as
    // `match.index + match[0].length - 1`, which pointed at the
    // trailing `:` instead and made matchBalanced scan from a
    // position with no opening bracket to balance against, silently
    // failing to find ANY macro call.)
    const end = matchBalanced(text, match.index, '(', ')');
    if (end === -1) continue;
    calls.push({
      name: match[1].toLowerCase(),
      argsText: text.slice(match.index + match[0].length, end - 1),
      start: match.index,
      end,
    });
    re.lastIndex = end;
  }
  return calls;
}

/**
 * If a `[...]` hook immediately follows `afterIndex` (only whitespace
 * between), return its inner text and the index just past its
 * closing `]`. Otherwise null.
 */
function matchFollowingHook(
  text: string,
  afterIndex: number,
): { inner: string; end: number } | null {
  let i = afterIndex;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '[') return null;
  const end = matchBalanced(text, i, '[', ']');
  if (end === -1) return null;
  return { inner: text.slice(i + 1, end - 1), end };
}

/**
 * Process one Harlowe-dialect passage body into the same
 * `{ content, choices }` shape twee-parser.ts's generic
 * extractLinks+bodyToContent pipeline produces for a plain passage —
 * this is what twee-parser.ts calls INSTEAD of that pipeline when the
 * detected dialect is 'harlowe'.
 */
export function processHarlowePassageBody(
  body: string,
  state: DialectVariableState,
  evaluateExpr: (expr: Expression, vars: Record<string, VariableValue>) => VariableValue,
  warnings: ValidationMessage[],
  lineNumber: number,
): { content: ContentBlock[]; choices: Choice[] } {
  const content: ContentBlock[] = [];
  const choices: Choice[] = [];

  // Scan left to right for the first recognized macro call anywhere
  // in the remaining text — NOT only when a macro is the entire
  // paragraph. A `(set:)` on its own line immediately followed by
  // prose on the very next line (no blank line between them) is the
  // common authoring shape, and a whole-paragraph-only check would
  // miss it entirely (confirmed by hand against a real fixture before
  // this rewrite). Text before/after a recognized macro is run
  // through the exact same generic extractLinks + bodyToContent
  // pipeline bodyToContent's own blank-line split handles plain prose
  // with, so paragraph breaks across non-macro text are preserved.
  let cursor = 0;
  while (cursor < body.length) {
    const remaining = body.slice(cursor);
    const call = findMacroCalls(remaining).find(
      (c) => c.name === 'set' || c.name === 'put' || c.name === 'if',
    );
    if (!call) {
      pushGenericParagraph(remaining, content, choices);
      break;
    }

    const before = remaining.slice(0, call.start);
    if (before.trim()) pushGenericParagraph(before, content, choices);

    if (call.name === 'set' || call.name === 'put') {
      const kind = call.name as 'set' | 'put';
      const assignments = parseSetOrPutArgs(kind, call.argsText, warnings, lineNumber);
      for (const { name, value } of assignments) {
        declareVariableIfNew(name, value, state, evaluateExpr, warnings, lineNumber);
        const statement: Statement = { kind: 'assignment', name, operator: '=', value };
        content.push({ kind: 'assignment', statement });
      }
      cursor += call.end;
      continue;
    }

    // call.name === 'if'
    const hook = matchFollowingHook(remaining, call.end);
    if (!hook) {
      // `(if: ...)` with nothing to gate — not a shape v1 understands
      // (Harlowe permits a macro with no hook following it in some
      // contexts, e.g. feeding (if:)'s boolean into another macro,
      // which isn't something this parser models). Leave the macro
      // call itself as inert text and keep scanning afterward.
      pushGenericParagraph(remaining.slice(call.start, call.end), content, choices);
      cursor += call.end;
      continue;
    }

    let condition: Expression;
    try {
      condition = parseExpression(translateHarloweExpression(call.argsText));
    } catch (err) {
      warnings.push({
        type: 'syntax_error',
        message: `Could not parse the condition in (if: ${call.argsText}): ${errorMessage(err)}`,
        lineNumber,
      });
      // Tolerant-degradation: leave the whole `(if: ...)[...]` as
      // LITERAL inert text — bodyToContent only (no extractLinks).
      // A hook can wrap a `[[Link]]` (the conditional-choice shape
      // below); running extractLinks on it here would still turn
      // that link into a real, unconditional Choice even though its
      // gating condition failed to parse, silently making it
      // always-visible instead of leaving it inert for the author to
      // notice via the warning above.
      content.push(...bodyToContent(remaining.slice(call.start, hook.end)));
      cursor += hook.end;
      continue;
    }
    // Block-flattening (plan architecture note): a link found inside
    // the hook becomes a Choice carrying the hook's condition; any
    // text left over after stripping links becomes a conditional
    // TextBlock.
    const { choices: innerChoices, contentBody: innerText } = extractLinks(hook.inner);
    for (const choice of innerChoices) {
      choices.push({ ...choice, condition });
    }
    for (const block of bodyToContent(innerText)) {
      content.push({ ...block, condition });
    }
    cursor += hook.end;
  }

  return { content, choices };
}

/** Fallback for a paragraph that isn't (one of) the specially-handled
 * macro shapes above — run it through the exact same generic
 * extractLinks + bodyToContent pipeline a non-macro passage gets, so
 * an unrecognized macro call stays exactly as inert text (same as
 * every Twee macro was before this phase) instead of disappearing. */
function pushGenericParagraph(paragraph: string, content: ContentBlock[], choices: Choice[]): void {
  const { choices: foundChoices, contentBody } = extractLinks(paragraph);
  choices.push(...foundChoices);
  content.push(...bodyToContent(contentBody));
}
