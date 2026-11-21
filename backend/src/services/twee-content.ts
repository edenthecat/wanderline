/**
 * Twee passage body helpers shared between the generic parser
 * (twee-parser.ts) and every dialect-specific macro module
 * (harlowe-macros.ts, and its SugarCube/Chapbook siblings).
 *
 * Pulled out of twee-parser.ts specifically to avoid a circular
 * import: a dialect module needs these to fall back to generic
 * handling for content it doesn't specially recognize (an
 * unsupported macro, plain prose), but twee-parser.ts also needs to
 * call INTO the dialect module to process a passage body in the
 * first place. Neither module imports the other; both import this.
 */

import { randomUUID } from 'crypto';
import { isListValue } from '../types.js';
import type {
  Choice,
  ContentBlock,
  Expression,
  TextContent,
  ValidationMessage,
  VariableDeclaration,
  VariableValue,
} from '../types.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read one quoted string literal starting at `source[start]` (which
 * must be a `"` or `'`). Only `\\` and `\<quote>` are recognized
 * escapes — a backslash before any other character (e.g. a Windows
 * path like 'C:\Users\x') is literal and must be kept, not eaten.
 * Returns the unescaped value and the index just past the closing
 * quote. Shared by every dialect's expression translator (Harlowe,
 * SugarCube) so a fix to this logic — it has a real history of edge
 * cases (DEV-199 Phase 7 review) — never has to be ported to a copy.
 */
export function readQuotedLiteral(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  let j = start + 1;
  let value = '';
  while (j < source.length && source[j] !== quote) {
    if (
      source[j] === '\\' &&
      j + 1 < source.length &&
      (source[j + 1] === '\\' || source[j + 1] === quote)
    ) {
      value += source[j + 1];
      j += 2;
      continue;
    }
    value += source[j];
    j++;
  }
  return { value, end: j + 1 };
}

/** Escape a raw string value for embedding in the canonical grammar's
 * double-quote-only string literal syntax. The inverse of
 * readQuotedLiteral's unescaping — shared by every dialect's
 * expression translator/renderer so the two directions can't drift
 * out of sync. */
/** A fresh stable id for a newly-parsed block/choice (DEV-199
 * stable-id rollout). Exported so the three dialect modules
 * (harlowe/sugarcube/chapbook-macros.ts) mint ids through this
 * shared module rather than each importing crypto directly — this
 * is already their one shared import point (see file header). */
export function newBlockId(): string {
  return randomUUID();
}

export function escapeDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Mutable, per-story state threaded through every passage of a
 * macro-based Twine dialect (Harlowe, SugarCube) so a variable seen
 * for the first time anywhere in the story — not just within one
 * passage — is the one that implicitly declares it, matching both
 * dialects' "first assignment wins" semantics (neither has a
 * separate upfront declaration syntax like Ink's VAR). */
export interface DialectVariableState {
  variables: VariableDeclaration[];
  values: Record<string, VariableValue>;
}

export function createVariableState(): DialectVariableState {
  return { variables: [], values: {} };
}

/**
 * Record `name`'s first-seen initial value as a declaration, unless
 * it's already declared. Mirrors ink-parser.ts's
 * parseVariableDeclarationLine: the type is inferred by evaluating
 * the initializer against variables already known. A value that
 * fails to evaluate (e.g. references a variable not yet declared)
 * skips the declaration rather than failing the whole parse — same
 * tolerant-degradation every dialect module uses — but, like
 * ink-parser.ts's own version, warns rather than failing silently: an
 * assignment statement still gets emitted into content for this macro
 * call regardless (it's valid source either way), and without the
 * warning an author gets no signal that `name` was never declared,
 * right up until this statement throws uncaught at actual playback.
 *
 * `displayName` is what the warning message names the variable as —
 * Harlowe/SugarCube pass `$name` (their own sigil form) to keep the
 * message consistent with what the author actually typed; Chapbook
 * has no sigil at all, so it can just pass `name` bare (the default).
 */
export function declareVariableIfNew(
  name: string,
  initialValue: Expression,
  state: DialectVariableState,
  evaluateExpr: (expr: Expression, vars: Record<string, VariableValue>) => VariableValue,
  warnings: ValidationMessage[],
  lineNumber: number,
  displayName: string = name,
): void {
  if (Object.hasOwn(state.values, name)) return;
  let value: VariableValue;
  try {
    value = evaluateExpr(initialValue, state.values);
  } catch (err) {
    warnings.push({
      type: 'syntax_error',
      message: `Could not determine a type for ${displayName}: ${errorMessage(err)}`,
      lineNumber,
    });
    return;
  }
  const type = isListValue(value)
    ? 'list'
    : typeof value === 'number'
      ? 'number'
      : typeof value === 'boolean'
        ? 'bool'
        : 'string';
  const listMembers = isListValue(value) ? value.allItems.map((item) => item.name) : undefined;
  state.variables.push({ name, type, initialValue, isConst: false, listMembers });
  state.values[name] = value;
}

/**
 * Extract every `[[...]]` link from `body`, returning the links as
 * Choices and the body with those links removed (they're modelled as
 * choices, not inline text). The optional trailing `[cond]` Harlowe/
 * SugarCube conditional-link suffix is matched and discarded here —
 * dialect modules that understand it extract their own condition
 * from the SURROUNDING macro/hook instead (see harlowe-macros.ts's
 * block-flattening), not from this suffix form.
 */
export function extractLinks(body: string): { choices: Choice[]; contentBody: string } {
  const choices: Choice[] = [];
  const linkPattern = /\[\[([^\][]*?)\]\](?:\[[^\]]*\])?/g;
  const contentBody = body.replace(linkPattern, (_full, inner: string) => {
    const link = parseLinkInner(inner);
    if (link) choices.push(link);
    return '';
  });
  return { choices, contentBody };
}

function parseLinkInner(inner: string): Choice | null {
  const trimmed = inner.trim();
  if (!trimmed) return null;
  let text: string;
  let target: string;
  // Split on the FIRST occurrence of the delimiter — `String.split`
  // returns every segment, so `'a->b->c'.split('->')` yields three
  // parts and destructuring silently drops `->c`. Use indexOf so a
  // delimiter appearing later in the text/target survives.
  //
  // Delimiter priority when multiple are present in the same link:
  // `|` beats `->`/`<-`. A link like `[[Attack -> retreat|Cave]]`
  // is authored as pipe form (text on the left, target on the right)
  // — splitting at `->` first would produce text='Attack' and
  // target='retreat|Cave' which is neither what the author wrote nor
  // a resolvable passage. Arrow-form links exist too but they never
  // legitimately contain a `|` in the text or target (Twee 3 spec).
  let idx: number;
  if ((idx = trimmed.indexOf('|')) !== -1) {
    // Shape: [[Text|Target]]
    text = trimmed.slice(0, idx).trim();
    target = trimmed.slice(idx + 1).trim();
  } else if ((idx = trimmed.indexOf('->')) !== -1) {
    // Shape: [[Text->Target]]
    text = trimmed.slice(0, idx).trim();
    target = trimmed.slice(idx + 2).trim();
  } else if ((idx = trimmed.indexOf('<-')) !== -1) {
    // Shape: [[Target<-Text]] (reversed)
    target = trimmed.slice(0, idx).trim();
    text = trimmed.slice(idx + 2).trim();
  } else {
    // Shape: [[Target]] — display text is the target name.
    text = trimmed;
    target = trimmed;
  }
  if (!target) return null;
  return {
    id: randomUUID(),
    text: text || target,
    target,
    sticky: false,
    fallback: false,
    tags: [],
  };
}

/** Fallback for passage text that isn't (one of) a dialect module's
 * own specially-handled macro/tag shapes — run it through the exact
 * same generic extractLinks + bodyToContent pipeline a non-macro
 * passage gets, so an unrecognized macro/tag stays exactly as inert
 * text (same as every Twee macro was before dialect support existed)
 * instead of disappearing. Shared by every dialect module so this
 * fallback behavior can't drift between them. */
export function pushGenericParagraph(
  paragraph: string,
  content: ContentBlock[],
  choices: Choice[],
): void {
  const { choices: foundChoices, contentBody } = extractLinks(paragraph);
  choices.push(...foundChoices);
  content.push(...bodyToContent(contentBody));
}

/**
 * Parse the raw body content into a TextContent[]. Twee stores prose
 * as a single flat block; we split on blank lines to give each paragraph
 * its own TextContent (parity with Ink's stitch-per-paragraph feel).
 */
export function bodyToContent(body: string): TextContent[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((text): TextContent => ({
      id: randomUUID(),
      // reverse the `\::` line-start escape the emitter
      // writes. Without this, a genuine `::` paragraph starts
      // gets a permanent leading backslash on every round-trip.
      // Only strips the ONE backslash that guards the delimiter;
      // authors who want a literal `\::` at line-start can
      // double-escape as `\\::` (and that only affects them if
      // they later mutate the graph, which is a fine trade).
      kind: 'text',
      text: text.replace(/(^|\n)\\::/g, '$1::'),
      tags: [],
    }));
}
