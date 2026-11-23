/**
 * SugarCube macro translation (DEV-199 Phase 8).
 *
 * SugarCube is a Twine story format whose expressions are plain
 * TwineScript (effectively JavaScript) with a set of word-form
 * operator aliases layered on top. This module translates its native
 * macro/expression syntax into the canonical Expression/Statement AST
 * (shared/src/expression-*.ts) that every dialect (and Ink) compiles
 * into — see twee-parser.ts's module doc and the variable-support
 * plan's architecture note. twee-parser.ts calls into this module
 * only when the detected dialect (DEV-199 Phase 6) is 'sugarcube';
 * Harlowe and Chapbook get their own sibling modules.
 *
 * Supported subset (v1):
 *   - `<<set $x to EXPR>>` / `<<set $x = EXPR>>`, including the native
 *     compound forms (`+=`, `-=`, `*=`, `/=`) — SugarCube has no
 *     separate declaration syntax, so the first `<<set>>` for a given
 *     $-variable anywhere in the story implicitly declares it
 *     (StoryGraph.variables), same as Harlowe's (set:)/(put:).
 *   - `<<if COND>>TEXT<<elseif COND2>>TEXT2<<else>>TEXT3<</if>>` →
 *     one conditional TextBlock per branch, with each branch's
 *     condition built from its own test ANDed with the negation of
 *     every earlier branch's test (so the branches stay mutually
 *     exclusive, matching if/elseif/else's actual runtime semantics).
 *     `<<elseif>>` and `<<else>>` are both optional; a bare `<<if>>`
 *     with no else branches is just the one-branch case.
 *   - Any branch's body that is just a wrapped `[[Link]]` (optionally
 *     alongside prose) produces a conditional Choice for that link
 *     instead of/in addition to a conditional TextBlock — the same
 *     per-branch block-flattening the plan's architecture section
 *     describes for all three Twine dialects, generalized from
 *     Harlowe's single-hook case to N if/elseif/else branches.
 *   - Expression syntax: `$name` variables (sigil stripped; `_name`
 *     temp variables are NOT stripped — see below), the TwineScript
 *     word-form operator aliases (`to`→`=`, `is`/`eq`→`==`,
 *     `isnot`/`neq`→`!=`, `gt`/`gte`/`lt`/`lte`→`>`/`>=`/`<`/`<=`,
 *     `and`/`or`/`not`→`&&`/`||`/`!`), and raw JS-style operators
 *     passed straight through unchanged (SugarCube accepts both
 *     forms natively, unlike Harlowe which only has the word forms).
 *     Canonical has no strict-vs-loose equality split, so `is`
 *     (SugarCube's `===`) and `eq` (`==`) both collapse to the same
 *     canonical `==` — a deliberate v1 simplification.
 *
 * Deliberately out of scope for v1 (left exactly as inert text, same
 * as every Twee macro was before this phase):
 *   - Temp variables (`_name`) — left un-stripped, so an expression
 *     using one fails to evaluate (undefined variable) and surfaces
 *     the same warning an undeclared $-variable would, rather than
 *     silently colliding with a same-named $-variable if both were
 *     stripped to the same bare identifier.
 *   - `def` / `ndef` (definedness checks) — no equivalent in the
 *     canonical AST.
 *   - Any other SugarCube macro — <<print>>, <<link>>, <<widget>>,
 *     arrays, custom macros, etc.
 */

import {
  parseExpression,
  parseStatement,
  expressionUsesListFeatures,
  expressionUsesFunctionCalls,
} from '@wanderline/shared';
import type {
  ContentBlock,
  Choice,
  Expression,
  Statement,
  ValidationMessage,
  VariableValue,
} from '../types.js';
import {
  bodyToContent,
  pushGenericParagraph,
  readQuotedLiteral,
  escapeDoubleQuoted,
  declareVariableIfNew,
  newBlockId,
  type DialectVariableState,
} from './twee-content.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Longest-first so e.g. "isnot" can never be mistaken for "is" (moot
// in practice since \b boundaries already keep them apart, but kept
// in an order a reader can trust at a glance).
function translateWordOperators(text: string): string {
  return text
    .replace(/\bisnot\b/gi, '!=')
    .replace(/\bis\b/gi, '==')
    .replace(/\bneq\b/gi, '!=')
    .replace(/\beq\b/gi, '==')
    .replace(/\bgte\b/gi, '>=')
    .replace(/\bgt\b/gi, '>')
    .replace(/\blte\b/gi, '<=')
    .replace(/\blt\b/gi, '<')
    .replace(/\band\b/gi, '&&')
    .replace(/\bor\b/gi, '||')
    .replace(/\bnot\b\s*/gi, '!')
    .replace(/\bto\b/gi, '=');
}

/**
 * Translate SugarCube expression (or `<<set>>` statement) syntax into
 * the canonical textual surface expression-parser.ts understands.
 * Tokenizes just enough to respect quoted strings and `$`-sigil
 * variable references — a naive whole-string regex would mangle a
 * string literal containing a bare "and"/"is"/"to" or a stray `$`.
 *
 * `to` is translated the same way everywhere (inside `<<set>>` args
 * as much as `<<if>>` conditions) since it never means anything else
 * in TwineScript — this lets `<<set $x to 5>>`'s WHOLE argument text
 * translate directly into a valid canonical statement (`x = 5`) with
 * no separate name/value splitting needed, unlike Harlowe's (set:)
 * which has no symbolic assignment form to fall back on.
 */
export function translateSugarCubeExpression(source: string): string {
  let out = '';
  let plainBuffer = '';
  let i = 0;

  const flushPlain = () => {
    if (plainBuffer) {
      out += translateWordOperators(plainBuffer);
      plainBuffer = '';
    }
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      flushPlain();
      const { value, end } = readQuotedLiteral(source, i);
      out += `"${escapeDoubleQuoted(value)}"`;
      i = end;
      continue;
    }
    if (ch === '$') {
      // Sigil strip: $name -> name. `_name` temp variables are
      // deliberately NOT stripped here — see the module doc's scope
      // note.
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
 * Render a canonical Expression back into SugarCube syntax — the
 * reverse of translateSugarCubeExpression, used by twee-emitter.ts.
 * Unlike Harlowe, SugarCube accepts raw JS-style operators natively,
 * so no word-form re-translation is needed on the way out. Every
 * binary/logical child is UNCONDITIONALLY parenthesized rather than
 * replicating expression-parser.ts's minimal-parens precedence logic
 * — an extra paren never changes meaning, so this trades slightly
 * noisier output for not having to re-derive a precedence table.
 */
export function renderSugarCubeExpression(
  expr: Expression,
  listVariableNames?: ReadonlySet<string>,
): string {
  if (expressionUsesListFeatures(expr, listVariableNames)) {
    throw new Error('SugarCube export does not support LIST expressions');
  }
  if (expressionUsesFunctionCalls(expr)) {
    // Function-knot calls (DEV-199 Phase 10b) are Ink-only — SugarCube
    // has no concept of a callable knot at all.
    throw new Error('SugarCube export does not support function calls');
  }
  switch (expr.kind) {
    case 'literal':
      if (typeof expr.value === 'string') {
        return `"${escapeDoubleQuoted(expr.value)}"`;
      }
      return String(expr.value);
    case 'variable':
      return `$${expr.name}`;
    case 'unary': {
      const operand = renderSugarCubeExpression(expr.operand, listVariableNames);
      return `${expr.operator}${operand}`;
    }
    case 'binary': {
      const left = renderSugarCubeExpression(expr.left, listVariableNames);
      const right = renderSugarCubeExpression(expr.right, listVariableNames);
      return `(${left} ${expr.operator} ${right})`;
    }
    case 'logical': {
      const left = renderSugarCubeExpression(expr.left, listVariableNames);
      const right = renderSugarCubeExpression(expr.right, listVariableNames);
      return `(${left} ${expr.operator} ${right})`;
    }
    case 'listFunction':
      // Ink's LIST type (DEV-199 Phase 10) is scoped to Ink only —
      // SugarCube has no equivalent, and nothing on this dialect's
      // own parsing side ever produces this expression kind, so
      // reaching here means a LIST-valued condition/assignment
      // somehow made it into a SugarCube export, which has no
      // correct rendering.
      throw new Error(`SugarCube export does not support LIST expressions (${expr.name})`);
    case 'call':
      // Already rejected up front by expressionUsesFunctionCalls
      // above — unreachable in practice, kept only so this switch
      // stays exhaustive over Expression's `kind`.
      throw new Error(`SugarCube export does not support function calls (${expr.name})`);
  }
}

/**
 * Render a canonical assignment Statement back into a `<<set ...>>`
 * macro call — used by twee-emitter.ts. Unlike Harlowe's (set:),
 * SugarCube's <<set>> accepts a compound operator directly, so a
 * compound statement (`gold += 10`) re-emits natively as
 * `<<set $gold += 10>>` with no expansion needed.
 */
export function renderSugarCubeAssignment(
  statement: Statement,
  listVariableNames?: ReadonlySet<string>,
): string {
  if (statement.kind === 'return') {
    // See renderHarloweAssignment's identical guard — SugarCube has
    // no function-knot equivalent either.
    throw new Error('SugarCube export does not support return statements');
  }
  return `<<set $${statement.name} ${statement.operator} ${renderSugarCubeExpression(
    statement.value,
    listVariableNames,
  )}>>`;
}

/** One `<<...>>` tag found in passage text: its (lowercased) name,
 * the raw text between the name and the closing `>>`, and the
 * [start, end) span of the whole tag. */
interface Tag {
  name: string;
  argsText: string;
  start: number;
  end: number;
}

const TAG_START_RE = /<<\s*(\/?[A-Za-z][A-Za-z0-9]*)/g;

// Names findTags warns about when their closing `>>` can't be found
// (see findTags) — an unrecognized tag staying silently inert is
// normal (every macro this module doesn't specially handle does
// that), but one of THESE names failing to close is almost always a
// stray quote inside the author's own condition/argument text, worth
// surfacing rather than silently dropping the whole tag with no
// diagnostic at all.
const RECOGNIZED_TAG_NAMES = new Set(['set', 'if', 'elseif', 'else', '/if']);

/**
 * Scan forward from `start` (which must index the `<` of a tag's
 * opening `<<`) and return the index one past its matching `>>`,
 * skipping over quoted strings so a `>>` inside a string argument
 * (e.g. `<<set $msg to "a >> b">>`) can't prematurely close the tag.
 * Returns -1 when no closing `>>` is found.
 */
function matchTagEnd(text: string, start: number): number {
  let i = start + 2;
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
    if (ch === '>' && text[i + 1] === '>') return i + 2;
    i++;
  }
  return -1;
}

/** Find every `<<name ...>>` tag in `text`, in order. Doesn't descend
 * into a tag's own arguments looking for nested tags — the only
 * nesting this module cares about (if/elseif/else/\/if) is tracked
 * separately by walking this flat list and counting depth.
 *
 * When a tag's closing `>>` can't be found (usually a stray quote
 * inside its own condition/argument text, e.g. `<<if $x is Bob's>>`)
 * the tag is dropped, same tolerant-degradation every dialect module
 * uses — but if its name is one of RECOGNIZED_TAG_NAMES, a warning is
 * raised first so the drop isn't completely silent; an unrecognized
 * custom macro name failing to close stays silent, since this module
 * never claimed to understand it in the first place.
 */
function findTags(text: string, warnings: ValidationMessage[], lineNumber: number): Tag[] {
  const tags: Tag[] = [];
  const re = new RegExp(TAG_START_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const end = matchTagEnd(text, match.index);
    if (end === -1) {
      const name = match[1].toLowerCase();
      if (RECOGNIZED_TAG_NAMES.has(name)) {
        warnings.push({
          type: 'syntax_error',
          message: `Could not find the closing ">>" for "<<${match[1]} ...>>" — check for a stray quote inside it.`,
          lineNumber,
        });
      }
      re.lastIndex = match.index + 2;
      continue;
    }
    tags.push({
      name: match[1].toLowerCase(),
      argsText: text.slice(match.index + match[0].length, end - 2).trim(),
      start: match.index,
      end,
    });
    re.lastIndex = end;
  }
  return tags;
}

/** One branch of an `<<if>>...<<elseif>>...<<else>>...<</if>>` chain:
 * `conditionText` is the raw (untranslated) condition source, or null
 * for an `<<else>>` branch (unconditionally true once every earlier
 * branch's test has failed). */
interface IfBranch {
  conditionText: string | null;
  bodyStart: number;
  bodyEnd: number;
}

/**
 * Given `tags` (as returned by findTags) and the index within it of
 * an `<<if>>` tag, walk forward tracking nesting depth to find its
 * matching `<</if>>` and split the span between them into branches at
 * every TOP-LEVEL (depth === 1) `<<elseif>>`/`<<else>>`. A nested
 * `<<if>>...<</if>>` inside a branch's own body is skipped over as a
 * single depth-tracked unit, not split into branches itself — its
 * tags simply aren't at depth 1 so they're never mistaken for one of
 * THIS if-chain's own branch separators.
 *
 * Returns null when the `<<if>>` is never closed (same
 * tolerant-degradation every dialect module uses for malformed
 * source — caller falls back to leaving it as inert text).
 */
function matchIfBlock(
  tags: Tag[],
  ifTagIndex: number,
): { branches: IfBranch[]; end: number } | null {
  const ifTag = tags[ifTagIndex];
  let depth = 1;
  const branches: IfBranch[] = [];
  let currentConditionText: string | null = ifTag.argsText;
  let currentBodyStart = ifTag.end;
  for (let k = ifTagIndex + 1; k < tags.length; k++) {
    const tag = tags[k];
    if (tag.name === 'if') {
      depth++;
      continue;
    }
    if (tag.name === '/if') {
      depth--;
      if (depth === 0) {
        branches.push({
          conditionText: currentConditionText,
          bodyStart: currentBodyStart,
          bodyEnd: tag.start,
        });
        return { branches, end: tag.end };
      }
      continue;
    }
    if (depth === 1 && (tag.name === 'elseif' || tag.name === 'else')) {
      branches.push({
        conditionText: currentConditionText,
        bodyStart: currentBodyStart,
        bodyEnd: tag.start,
      });
      currentConditionText = tag.name === 'elseif' ? tag.argsText : null;
      currentBodyStart = tag.end;
    }
  }
  return null;
}

function and(left: Expression, right: Expression): Expression {
  return { kind: 'logical', operator: '&&', left, right };
}

function not(expr: Expression): Expression {
  return { kind: 'unary', operator: '!', operand: expr };
}

/**
 * Process one SugarCube-dialect passage body into the same
 * `{ content, choices }` shape twee-parser.ts's generic
 * extractLinks+bodyToContent pipeline produces for a plain passage —
 * this is what twee-parser.ts calls INSTEAD of that pipeline when the
 * detected dialect is 'sugarcube'.
 */
export function processSugarCubePassageBody(
  body: string,
  state: DialectVariableState,
  evaluateExpr: (expr: Expression, vars: Record<string, VariableValue>) => VariableValue,
  warnings: ValidationMessage[],
  lineNumber: number,
): { content: ContentBlock[]; choices: Choice[] } {
  const content: ContentBlock[] = [];
  const choices: Choice[] = [];

  // Same cursor-based left-to-right scan as harlowe-macros.ts (see
  // its module doc for why a whole-paragraph-only check would miss
  // the common `<<set>>` immediately followed by prose authoring
  // shape): find the first recognized tag ANYWHERE in the remaining
  // text, process text before it generically, handle the tag, and
  // advance past it.
  let cursor = 0;
  while (cursor < body.length) {
    const remaining = body.slice(cursor);
    const tags = findTags(remaining, warnings, lineNumber);
    const tagIndex = tags.findIndex((t) => t.name === 'set' || t.name === 'if');
    if (tagIndex === -1) {
      pushGenericParagraph(remaining, content, choices);
      break;
    }
    const tag = tags[tagIndex];

    const before = remaining.slice(0, tag.start);
    if (before.trim()) pushGenericParagraph(before, content, choices);

    if (tag.name === 'set') {
      const translated = translateSugarCubeExpression(tag.argsText);
      try {
        const statement = parseStatement(translated);
        if (statement.kind === 'return') {
          // `return` is only meaningful inside a function-knot
          // (DEV-199 Phase 10b) — SugarCube has no such concept, so
          // `<<set return>>`/`<<set return = x>>` (an author
          // literally naming a variable `return`, or a stray typo)
          // is rejected the same way an unparseable RHS already is,
          // rather than silently producing a bogus ReturnStatement
          // content block.
          throw new Error("'return' is not a valid <<set>> target");
        }
        if (statement.operator === '=') {
          declareVariableIfNew(
            statement.name,
            statement.value,
            state,
            evaluateExpr,
            warnings,
            lineNumber,
            `$${statement.name}`,
          );
        } else if (!Object.hasOwn(state.values, statement.name)) {
          // A compound op (+=/-=/etc) can't declare a variable — it
          // needs an EXISTING value to combine with. Real SugarCube
          // would evaluate this against `undefined` (producing NaN
          // or string-concatenation garbage), so warn rather than
          // guessing a type/initialValue from the bare RHS, which
          // would silently misreport what this statement actually
          // does (e.g. `<<set $gold += 10>>` as $gold's first-ever
          // mention must NOT be reported as "$gold starts at 10").
          warnings.push({
            type: 'syntax_error',
            message: `$${statement.name} is modified with "${statement.operator}" before any plain <<set $${statement.name} to ...>> declares it.`,
            lineNumber,
          });
        }
        content.push({ id: newBlockId(), kind: 'assignment', statement });
      } catch (err) {
        warnings.push({
          type: 'syntax_error',
          message: `Could not parse <<set ${tag.argsText}>>: ${errorMessage(err)}`,
          lineNumber,
        });
      }
      cursor += tag.end;
      continue;
    }

    // tag.name === 'if'
    const block = matchIfBlock(tags, tagIndex);
    if (!block) {
      // Unterminated <<if>> — leave the tag itself as inert text and
      // keep scanning afterward, same tolerant-degradation Harlowe's
      // module uses for a macro call with nothing to gate.
      pushGenericParagraph(remaining.slice(tag.start, tag.end), content, choices);
      cursor += tag.end;
      continue;
    }

    // Each branch's effective condition is its own test ANDed with
    // the negation of every earlier branch's test, so the branches
    // stay mutually exclusive (matching if/elseif/else's actual
    // runtime semantics) rather than letting a later TRUE branch
    // double-fire alongside an earlier one. Branch output is staged
    // into pendingContent/pendingChoices and only merged into the
    // real content/choices arrays once the WHOLE chain has parsed
    // successfully — a structural guarantee against discarding
    // anything unrelated that might land in content/choices in
    // between, which a snapshot-the-length-then-truncate approach
    // would be one future edit away from breaking.
    const pendingContent: ContentBlock[] = [];
    const pendingChoices: Choice[] = [];
    let priorNegations: Expression | null = null;
    let sawBrokenCondition = false;
    for (const branch of block.branches) {
      let branchCondition: Expression | null = null;
      if (branch.conditionText !== null) {
        try {
          branchCondition = parseExpression(translateSugarCubeExpression(branch.conditionText));
        } catch (err) {
          warnings.push({
            type: 'syntax_error',
            message: `Could not parse the condition in <<if ${branch.conditionText}>>: ${errorMessage(err)}`,
            lineNumber,
          });
          sawBrokenCondition = true;
          break;
        }
      }
      const effectiveCondition: Expression | null =
        branchCondition && priorNegations
          ? and(priorNegations, branchCondition)
          : (branchCondition ?? priorNegations);
      if (effectiveCondition) {
        const branchText = remaining.slice(branch.bodyStart, branch.bodyEnd);
        if (/<<\s*set\b/i.test(branchText)) {
          // A <<set>> nested inside a conditional block has no way
          // to be represented yet — ContentBlock's assignment variant
          // has no `condition` field, so there's no honest way to
          // make it run only when this branch is active. Leaving the
          // branch as literal text (with a warning) is less wrong
          // than silently running the assignment unconditionally.
          warnings.push({
            type: 'syntax_error',
            message:
              '<<set>> inside a conditional <<if>>/<<elseif>>/<<else>> block is not supported yet — move the assignment outside the block.',
            lineNumber,
          });
          pendingContent.push(...bodyToContent(branchText));
        } else {
          // Recurse so a nested <<if>> (and any plain prose/links) is
          // fully understood, not just left as literal text — this
          // is a strict generalization of the old extractLinks-only
          // handling: a branch with no nested macros recurses into
          // exactly the same { no tag found -> pushGenericParagraph }
          // fallback path, so simple branches are unaffected.
          const nested = processSugarCubePassageBody(
            branchText,
            state,
            evaluateExpr,
            warnings,
            lineNumber,
          );
          for (const choice of nested.choices) {
            pendingChoices.push({
              ...choice,
              condition: choice.condition
                ? and(effectiveCondition, choice.condition)
                : effectiveCondition,
            });
          }
          for (const b of nested.content) {
            if (b.kind === 'assignment') {
              pendingContent.push(b);
              continue;
            }
            pendingContent.push({
              ...b,
              condition: b.condition ? and(effectiveCondition, b.condition) : effectiveCondition,
            });
          }
        }
      }
      if (branchCondition) {
        priorNegations = priorNegations
          ? and(priorNegations, not(branchCondition))
          : not(branchCondition);
      }
    }
    if (sawBrokenCondition) {
      // Tolerant-degradation: the WHOLE if/elseif/else chain becomes
      // literal inert text (bodyToContent only, no extractLinks) —
      // same reasoning as Harlowe's hook-with-unparseable-condition
      // case: a branch wrapping a `[[Link]]` must not get silently
      // promoted to an unconditional Choice just because a sibling
      // branch's condition failed to parse. pendingContent/
      // pendingChoices are simply never merged in this case.
      content.push(...bodyToContent(remaining.slice(tag.start, block.end)));
    } else {
      content.push(...pendingContent);
      choices.push(...pendingChoices);
    }
    cursor += block.end;
  }

  return { content, choices };
}
