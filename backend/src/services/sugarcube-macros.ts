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

import { parseExpression, parseStatement } from '@wanderline/shared';
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
export function renderSugarCubeExpression(expr: Expression): string {
  switch (expr.kind) {
    case 'literal':
      if (typeof expr.value === 'string') {
        return `"${escapeDoubleQuoted(expr.value)}"`;
      }
      return String(expr.value);
    case 'variable':
      return `$${expr.name}`;
    case 'unary': {
      const operand = renderSugarCubeExpression(expr.operand);
      return `${expr.operator}${operand}`;
    }
    case 'binary': {
      const left = renderSugarCubeExpression(expr.left);
      const right = renderSugarCubeExpression(expr.right);
      return `(${left} ${expr.operator} ${right})`;
    }
    case 'logical': {
      const left = renderSugarCubeExpression(expr.left);
      const right = renderSugarCubeExpression(expr.right);
      return `(${left} ${expr.operator} ${right})`;
    }
  }
}

/**
 * Render a canonical assignment Statement back into a `<<set ...>>`
 * macro call — used by twee-emitter.ts. Unlike Harlowe's (set:),
 * SugarCube's <<set>> accepts a compound operator directly, so a
 * compound statement (`gold += 10`) re-emits natively as
 * `<<set $gold += 10>>` with no expansion needed.
 */
export function renderSugarCubeAssignment(statement: Statement): string {
  return `<<set $${statement.name} ${statement.operator} ${renderSugarCubeExpression(
    statement.value,
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
 * separately by walking this flat list and counting depth. */
function findTags(text: string): Tag[] {
  const tags: Tag[] = [];
  const re = new RegExp(TAG_START_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const end = matchTagEnd(text, match.index);
    if (end === -1) {
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
    const tags = findTags(remaining);
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
        declareVariableIfNew(
          statement.name,
          statement.value,
          state,
          evaluateExpr,
          warnings,
          lineNumber,
        );
        content.push({ kind: 'assignment', statement });
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
    // double-fire alongside an earlier one.
    const contentLengthBeforeThisIf = content.length;
    const choicesLengthBeforeThisIf = choices.length;
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
        const { choices: innerChoices, contentBody: innerText } = extractLinks(
          remaining.slice(branch.bodyStart, branch.bodyEnd),
        );
        for (const choice of innerChoices)
          choices.push({ ...choice, condition: effectiveCondition });
        for (const b of bodyToContent(innerText))
          content.push({ ...b, condition: effectiveCondition });
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
      // branch's condition failed to parse.
      content.length = contentLengthBeforeThisIf;
      choices.length = choicesLengthBeforeThisIf;
      content.push(...bodyToContent(remaining.slice(tag.start, block.end)));
    }
    cursor += block.end;
  }

  return { content, choices };
}

/** Fallback for a paragraph that isn't (one of) the specially-handled
 * tag shapes above — run it through the exact same generic
 * extractLinks + bodyToContent pipeline a non-macro passage gets, so
 * an unrecognized tag stays exactly as inert text (same as every
 * Twee macro was before this phase) instead of disappearing. */
function pushGenericParagraph(paragraph: string, content: ContentBlock[], choices: Choice[]): void {
  const { choices: foundChoices, contentBody } = extractLinks(paragraph);
  choices.push(...foundChoices);
  content.push(...bodyToContent(contentBody));
}
