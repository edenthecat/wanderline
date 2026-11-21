/**
 * Chapbook macro translation (DEV-199 Phase 9).
 *
 * Chapbook is structurally the most different of the three Twine
 * dialects (see the variable-support plan's architecture note and
 * this phase's own ticket): variables are declared in a dedicated
 * _vars section_ at the very top of a passage (separated from the
 * displayed text by a bare `--` line) rather than via inline macros
 * interleaved with prose, and conditional display uses standalone
 * `[if]`/`[unless]`/`[else]`/`[continue]` MODIFIER lines that apply
 * to everything following them — rather than a bracketed/nested block
 * like Harlowe's hook or SugarCube's `<<if>>...<</if>>` — up until
 * the next modifier changes or resets it. Chapbook modifiers cannot
 * be nested at all (confirmed by the official guide), which is
 * actually a simplification versus Harlowe/SugarCube: there is no
 * bracket-depth tracking to get wrong here.
 *
 * This module translates Chapbook's native vars-section/modifier
 * syntax into the canonical Expression/Statement AST
 * (shared/src/expression-*.ts) that every dialect (and Ink) compiles
 * into — see twee-parser.ts's module doc. twee-parser.ts calls into
 * this module only when the detected dialect (DEV-199 Phase 6) is
 * 'chapbook'; Harlowe and SugarCube have their own sibling modules.
 *
 * Supported subset (v1):
 *   - A leading vars section (lines of `name: EXPR`, ending at a bare
 *     `--` line) → one AssignmentBlock per line, implicitly declaring
 *     each $-less `name` on its first-ever mention anywhere in the
 *     story (StoryGraph.variables), same "first assignment wins"
 *     semantics as Harlowe/SugarCube. Multiple lines assigning the
 *     SAME name in one vars section are honored in file order (each
 *     becomes its own AssignmentBlock, matching "Chapbook changes the
 *     variables in the order they are written, top to bottom").
 *   - `[if EXPR]` / `[unless EXPR]` / `[else]` / `[continue]`
 *     modifier lines, each starting their own paragraph (a
 *     blank-line-delimited chunk) and applying to every paragraph
 *     that follows until the next modifier appears — `[continue]`
 *     resets back to unconditional, `[else]` negates the most recent
 *     `[if]`'s (not `[unless]`'s) condition specifically, matching
 *     the official guide's documented (if slightly surprising)
 *     semantics. A paragraph whose body is just a wrapped `[[Link]]`
 *     produces a conditional Choice instead of/alongside a
 *     conditional TextBlock — the same per-paragraph block-flattening
 *     the plan's architecture section describes for all three Twine
 *     dialects.
 *   - Expression syntax: bare (sigil-less) identifiers — Chapbook has
 *     no `$`/`_` variable prefix convention to strip — `===`/`!==`
 *     (→ canonical's `==`/`!=`; Chapbook has no loose-equality
 *     operator to preserve separately), and every other operator
 *     (`+`/`-`/`*`/`/`/`>`/`>=`/`<`/`<=`/`!`/`&&`/`||`) passed straight
 *     through unchanged — these are already exactly the canonical
 *     grammar's own symbols, so no word-form translation table is
 *     needed at all (unlike Harlowe, and unlike SugarCube's optional
 *     aliases).
 *
 * Deliberately out of scope for v1 (left exactly as inert text, same
 * as every Twee macro/modifier was before this phase):
 *   - A conditional vars-section assignment, `name (EXPR): VALUE`
 *     (only takes effect when EXPR is true) — there's no way to
 *     represent a conditional Statement yet (AssignmentBlock has no
 *     `condition` field, the same gap SugarCube's nested-<<set>> case
 *     hit in review). The line is skipped with a warning rather than
 *     being misread as an unconditional assignment.
 *   - `[ifalways]` / `[ifnever]` (debug-only overrides per the guide).
 *   - Variable names starting with `$` or `_` (Chapbook allows both
 *     as the FIRST character, but the canonical grammar's identifier
 *     syntax doesn't accept `$`; `_`-prefixed "local" names are
 *     accepted as ordinary identifiers, same as any other name, since
 *     Chapbook — unlike SugarCube — doesn't treat them specially).
 *   - Variable inserts in displayed text (`{name}`) and any other
 *     insert/modifier — {embed passage}, [JavaScript], etc.
 */

import { parseExpression, expressionUsesListFeatures } from '@wanderline/shared';
import type {
  Choice,
  ContentBlock,
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
  extractLinks,
  newBlockId,
  type DialectVariableState,
} from './twee-content.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Translate Chapbook expression syntax into the canonical textual
 * surface expression-parser.ts understands. Unlike Harlowe/
 * SugarCube's translators, this is a direct character scan with no
 * regex-replace pass over assembled output at all — Chapbook has no
 * word-form operators and no sigil to strip, so the only translation
 * needed is `===`/`!==` -> `==`/`!=` and re-quoting a string literal,
 * both handled inline as each character is visited. This sidesteps
 * the whole class of bug Harlowe's review caught (a regex meant for
 * "real" operators matching the same word/symbols inside an
 * already-translated string's content), since nothing here ever
 * re-scans text that came from inside a string.
 */
export function translateChapbookExpression(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const { value, end } = readQuotedLiteral(source, i);
      out += `"${escapeDoubleQuoted(value)}"`;
      i = end;
      continue;
    }
    if (ch === '=' && source[i + 1] === '=' && source[i + 2] === '=') {
      out += '==';
      i += 3;
      continue;
    }
    if (ch === '!' && source[i + 1] === '=' && source[i + 2] === '=') {
      out += '!=';
      i += 3;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Render a canonical Expression back into Chapbook syntax — the
 * reverse of translateChapbookExpression, used by twee-emitter.ts.
 * Every binary/logical child is UNCONDITIONALLY parenthesized rather
 * than replicating expression-parser.ts's minimal-parens precedence
 * logic — an extra paren never changes meaning, so this trades
 * slightly noisier output for not having to re-derive a precedence
 * table (same choice Harlowe/SugarCube's renderers make).
 */
export function renderChapbookExpression(expr: Expression): string {
  if (expressionUsesListFeatures(expr)) {
    throw new Error('Chapbook export does not support LIST expressions');
  }
  switch (expr.kind) {
    case 'literal':
      if (typeof expr.value === 'string') {
        return `"${escapeDoubleQuoted(expr.value)}"`;
      }
      return String(expr.value);
    case 'variable':
      return expr.name;
    case 'unary': {
      const operand = renderChapbookExpression(expr.operand);
      return `${expr.operator}${operand}`;
    }
    case 'binary': {
      const left = renderChapbookExpression(expr.left);
      const right = renderChapbookExpression(expr.right);
      const operator =
        expr.operator === '==' ? '===' : expr.operator === '!=' ? '!==' : expr.operator;
      return `(${left} ${operator} ${right})`;
    }
    case 'logical': {
      const left = renderChapbookExpression(expr.left);
      const right = renderChapbookExpression(expr.right);
      return `(${left} ${expr.operator} ${right})`;
    }
    case 'listFunction':
      // Ink's LIST type (DEV-199 Phase 10) is scoped to Ink only —
      // Chapbook has no equivalent, and nothing on this dialect's own
      // parsing side ever produces this expression kind, so reaching
      // here means a LIST-valued condition/assignment somehow made
      // it into a Chapbook export, which has no correct rendering.
      throw new Error(`Chapbook export does not support LIST expressions (${expr.name})`);
  }
}

/**
 * Render a canonical assignment Statement back into a vars-section
 * line (`name: VALUE`) — used by twee-emitter.ts, which hoists every
 * assignment block to the top of the passage as its own vars section
 * rather than rendering it inline (see that module's Chapbook-
 * specific branch). Chapbook has no compound-assignment shorthand (no
 * `+=` — "Variables Can Be Calculated" in the official guide always
 * spells it out: `dollarsInPocket: dollarsInPocket + 1`), so a
 * compound statement is expanded the same way Harlowe's (set:)
 * re-emission already does.
 */
export function renderChapbookAssignment(statement: Statement): string {
  if (statement.operator === '=') {
    return `${statement.name}: ${renderChapbookExpression(statement.value)}`;
  }
  const baseOperator = statement.operator.slice(0, -1);
  return `${statement.name}: ${statement.name} ${baseOperator} ${renderChapbookExpression(statement.value)}`;
}

/** A vars-section line matches `name: EXPR` or `name (COND): EXPR` —
 * the parenthesized form is a conditional assignment, out of scope
 * for v1 (see module doc), recognized here only so it can be skipped
 * with a warning rather than being misread as unconditional. */
const VAR_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*:\s*(.+)$/;

/**
 * Split `body` into its leading vars section (if any) and the rest of
 * the passage. Scans from the top, line by line: a bare `--` line
 * ends the vars section (everything after it is `rest`); a line
 * matching VAR_LINE_RE is accumulated as an assignment; anything else
 * means there was never a vars section in the first place (real
 * Chapbook always separates one with `--`, so hitting a non-matching
 * line before finding it means this isn't vars-section content at
 * all) — the WHOLE body is returned as `rest`, conservatively, rather
 * than guessing which prefix might have been "real" vars lines.
 */
function splitVarsSection(
  body: string,
  warnings: ValidationMessage[],
  lineNumber: number,
): { assignments: { name: string; value: Expression }[]; rest: string } {
  const lines = body.split('\n');
  const assignments: { name: string; value: Expression }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '--') {
      return { assignments, rest: lines.slice(i + 1).join('\n') };
    }
    if (trimmed === '') continue;
    const match = trimmed.match(VAR_LINE_RE);
    if (!match) {
      return { assignments: [], rest: body };
    }
    const [, name, conditionText, exprSource] = match;
    if (conditionText !== undefined) {
      warnings.push({
        type: 'syntax_error',
        message: `Chapbook's conditional vars-section assignment ("${name} (${conditionText}): ...") is not supported yet — this line will be skipped.`,
        lineNumber,
      });
      continue;
    }
    try {
      const value = parseExpression(translateChapbookExpression(exprSource));
      assignments.push({ name, value });
    } catch (err) {
      warnings.push({
        type: 'syntax_error',
        message: `Could not parse the vars-section line "${trimmed}": ${errorMessage(err)}`,
        lineNumber,
      });
    }
  }
  // Reached the end of the body without ever finding a "--" line —
  // real Chapbook always has one when a vars section is present, so
  // there wasn't one here at all (every line coincidentally looked
  // var-line-shaped, or the body is empty).
  return { assignments: [], rest: body };
}

/** A recognized modifier line's name and (for if/unless) its raw,
 * untranslated condition text. */
const MODIFIER_RE = /^\[(if|unless|else|continue)(?:\s+([^\]]*))?\]$/i;

function not(expr: Expression): Expression {
  return { kind: 'unary', operator: '!', operand: expr };
}

/**
 * Process one Chapbook-dialect passage body into the same
 * `{ content, choices }` shape twee-parser.ts's generic
 * extractLinks+bodyToContent pipeline produces for a plain passage —
 * this is what twee-parser.ts calls INSTEAD of that pipeline when the
 * detected dialect is 'chapbook'.
 */
export function processChapbookPassageBody(
  body: string,
  state: DialectVariableState,
  evaluateExpr: (expr: Expression, vars: Record<string, VariableValue>) => VariableValue,
  warnings: ValidationMessage[],
  lineNumber: number,
): { content: ContentBlock[]; choices: Choice[] } {
  const content: ContentBlock[] = [];
  const choices: Choice[] = [];

  const { assignments, rest } = splitVarsSection(body, warnings, lineNumber);
  for (const { name, value } of assignments) {
    declareVariableIfNew(name, value, state, evaluateExpr, warnings, lineNumber);
    content.push({
      id: newBlockId(),
      kind: 'assignment',
      statement: { kind: 'assignment', name, operator: '=', value },
    });
  }

  // Paragraph-by-paragraph state machine, NOT a block/depth scan —
  // Chapbook modifiers genuinely cannot nest (confirmed by the
  // official guide), so there's no bracket-matching needed at all,
  // unlike Harlowe's hooks or SugarCube's <<if>>...<</if>>. A
  // modifier line, when present, is always the FIRST line of its
  // (blank-line-delimited) paragraph; its effect persists across
  // every later paragraph until a later modifier changes it.
  let currentCondition: Expression | null = null;
  let lastIfCondition: Expression | null = null;
  for (const rawParagraph of rest.split(/\n\s*\n/)) {
    const trimmedParagraph = rawParagraph.trim();
    if (!trimmedParagraph) continue;
    const lines = trimmedParagraph.split('\n');
    const modifierMatch = lines[0].trim().match(MODIFIER_RE);

    let textLines = lines;
    if (modifierMatch) {
      const [, modifierName, argsText] = modifierMatch;
      textLines = lines.slice(1);
      const name = modifierName.toLowerCase();
      if (name === 'continue') {
        currentCondition = null;
        lastIfCondition = null;
      } else if (name === 'else') {
        if (lastIfCondition) {
          currentCondition = not(lastIfCondition);
        } else {
          warnings.push({
            type: 'syntax_error',
            message: '[else] with no preceding [if] in this passage — leaving it as literal text.',
            lineNumber,
          });
          // No prior [if] to pair with — tolerant-degradation: leave
          // THIS paragraph (modifier line included) as inert literal
          // text rather than guessing what it should negate, and
          // don't touch currentCondition/lastIfCondition.
          content.push(...bodyToContent(trimmedParagraph));
          continue;
        }
      } else {
        // if / unless
        try {
          const condition = parseExpression(translateChapbookExpression(argsText ?? ''));
          currentCondition = name === 'unless' ? not(condition) : condition;
          lastIfCondition = name === 'if' ? condition : lastIfCondition;
        } catch (err) {
          warnings.push({
            type: 'syntax_error',
            message: `Could not parse the condition in [${modifierName} ${argsText ?? ''}]: ${errorMessage(err)}`,
            lineNumber,
          });
          // Tolerant-degradation: leave the WHOLE paragraph (modifier
          // line included) as literal inert text — bodyToContent
          // only, no extractLinks, so a wrapped [[Link]] can't be
          // silently promoted to an unconditional Choice just because
          // this modifier's own condition failed to parse. currentCondition
          // is left unchanged so later paragraphs aren't affected by
          // this one failing.
          content.push(...bodyToContent(trimmedParagraph));
          continue;
        }
      }
    }

    const remainingText = textLines.join('\n');
    if (!remainingText.trim()) continue;
    if (currentCondition) {
      const { choices: found, contentBody } = extractLinks(remainingText);
      for (const choice of found) choices.push({ ...choice, condition: currentCondition });
      for (const block of bodyToContent(contentBody))
        content.push({ ...block, condition: currentCondition });
    } else {
      pushGenericParagraph(remainingText, content, choices);
    }
  }

  return { content, choices };
}
