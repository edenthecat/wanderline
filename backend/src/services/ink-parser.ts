/**
 * Ink Parser Service
 * Parses .ink files into the Wanderline story graph format
 */

import { randomUUID } from 'crypto';
import { parseExpression, parseStatement, evaluate, isListValue } from '@wanderline/shared';
import type {
  StoryGraph,
  StoryNode,
  TextContent,
  Choice,
  ValidationResult,
  ValidationMessage,
  Expression,
  Statement,
  VariableDeclaration,
  VariableType,
  VariableValue,
  ListItem,
  ExpressionParseContext,
} from '../types.js';

// Re-export types for convenience
export type { StoryGraph, StoryNode, ValidationResult };

interface ParserState {
  currentKnot: string | null;
  currentStitch: string | null;
  nodes: Map<string, StoryNode>;
  lineNumber: number;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  pendingDivert: string | null; // For handling diverts on the line after a choice
  lastChoiceIndex: number | null; // Track last choice to attach pending diverts
  // line indices that look-ahead has already consumed (a
  // `-> target` on the line after a choice). The main parse loop
  // skips these so the divert isn't double-counted as a fall-through
  // attached to the parent knot.
  consumedLines: Set<number>;
  // DEV-199 Phase 1: VAR/CONST preamble declarations, in file order.
  variables: VariableDeclaration[];
  // Values of variables declared so far (by name), kept ONLY to
  // type-infer each subsequent VAR/CONST's initializer when it
  // references an earlier declaration (Ink allows `VAR b = a * 2`).
  // Not consulted anywhere else — the actual runtime variable store
  // lives in the player (Phase 2).
  variableValues: Record<string, VariableValue>;
  // DEV-199 Phase 10: every LIST member declared so far, across every
  // LIST in the file, and each LIST's full member set — threaded into
  // every parseExpression/parseStatement call below as `context` so
  // a bare `cold` in a LATER condition/assignment resolves as a list
  // literal, not an undeclared-variable reference.
  listMembers: Record<string, { origin: string; ordinal: number }>;
  listDefinitions: Record<string, ListItem[]>;
}

const IMPLICIT_START_NODE = '_intro';

/**
 * Parse an Ink file into a StoryGraph
 */
export function parseInk(source: string, storyId: string, title?: string): StoryGraph {
  const state: ParserState = {
    currentKnot: null,
    currentStitch: null,
    nodes: new Map(),
    lineNumber: 0,
    errors: [],
    warnings: [],
    pendingDivert: null,
    lastChoiceIndex: null,
    consumedLines: new Set(),
    variables: [],
    variableValues: {},
    listMembers: {},
    listDefinitions: {},
  };

  const lines = source.split('\n');

  // First pass: check if there's content before the first knot
  let hasContentBeforeFirstKnot = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    // Check if this is a knot declaration
    if (isKnotDeclaration(trimmed)) {
      break;
    }

    // A VAR/CONST/LIST preamble line is a declaration, not story
    // content — without this, a leading `VAR gold = 50` (or `LIST
    // kettleState = ...`) would trip the "content before first knot"
    // check and spawn an unwanted implicit start node.
    if (VARIABLE_DECL_RE.test(trimmed) || LIST_DECL_RE.test(trimmed)) continue;

    // Found non-empty, non-comment content before a knot
    hasContentBeforeFirstKnot = true;
    break;
  }

  // Create implicit start node if needed
  if (hasContentBeforeFirstKnot) {
    createImplicitStartNode(state);
  }

  for (let i = 0; i < lines.length; i++) {
    if (state.consumedLines.has(i)) continue;
    state.lineNumber = i + 1;
    const line = lines[i];
    parseLine(line, state, lines, i);
  }

  // Convert Map to Record.
  //
  // Null-prototype: `__proto__` matches the knot rule's `\w+`, and
  // assigning it on a plain literal hits the prototype setter — the
  // knot never becomes an own property, and worse, `nodes`' prototype
  // silently becomes that StoryNode, so unguarded lookups elsewhere
  // start returning its `id`/`type`/`content` for any missing key.
  const nodes: Record<string, StoryNode> = Object.create(null);
  state.nodes.forEach((node, id) => {
    nodes[id] = node;
  });

  // Qualify bare stitch targets now that every node is known. Has to
  // be a second pass: a choice can point at a stitch declared further
  // down the file, so this can't be decided while parsing.
  resolveBareStitchTargets(nodes);

  // Determine start node
  const startNode = findStartNode(nodes);

  // Run validation
  const validation = validateGraph(nodes, startNode, state.errors, state.warnings);

  return {
    id: storyId,
    title: title || extractTitle(source) || 'Untitled Story',
    nodes,
    startNode,
    validation,
    source,
    ...(state.variables.length > 0 ? { variables: state.variables } : {}),
  };
}

// Knot declaration regex. Allows:
//   - 2 or 3 leading `=`
//   - optional `function` keyword (function knot — runtime-only, but we
//     still want to create a node so subsequent content doesn't leak
//     onto the previous knot)
//   - name (\w+)
//   - optional `()` for function-knots, with optional arg list
//   - optional 0-3 trailing `=`
//   - optional trailing whitespace
// Trailing `# tag` / `// comment` are stripped from the line before
// this regex sees it (see stripLineComment / parseLine), so they don't
// have to be part of the pattern.
// Capture groups:
//   1: "function " keyword if present (function knot)
//   2: knot name
//   3: trailing tag block (everything from the first `#` to EOL, if any)
// Ink's spec allows ANY number of `=` ≥ 2 on a knot declaration —
// authors routinely write `==== name ====` or `========= name ==`
// as visual separators. Our previous {2,3} bound silently dropped
// those knots, which then surfaced as bogus "missing target"
// warnings on every choice that pointed at them (repro: a real
// project upload had `==== name ===` on a knot header far into
// the .ink source, and every reference to that knot logged as
// missing).
const KNOT_DECL_RE = /^={2,}\s*(function\s+)?(\w+)\s*(?:\([^)]*\))?\s*={0,}\s*(#.*)?$/;

function isKnotDeclaration(trimmed: string): boolean {
  return KNOT_DECL_RE.test(stripLineComment(trimmed).trimEnd());
}

// VAR/CONST declaration (DEV-199 Phase 1). Ink declares these at
// global scope — conventionally at the top of the file, but not
// required to be — so this is matched wherever parseLine encounters
// it, not just in a "preamble" position.
const VARIABLE_DECL_RE = /^(VAR|CONST)\s+(\w+)\s*=\s*(.+)$/;

// LIST declaration (DEV-199 Phase 10) — same "wherever it appears"
// scoping as VAR/CONST above.
const LIST_DECL_RE = /^LIST\s+(\w+)\s*=\s*(.+)$/;

/** The known-list-members context every parseExpression/parseStatement
 * call in this file needs, so a bare identifier matching a LIST
 * member declared EARLIER in the file resolves as a list literal. A
 * list member declared LATER in the file is simply not yet known at
 * the point an earlier line is parsed — same ordering rule Ink's own
 * VAR/CONST forward-reference handling already has (state.variableValues
 * only has what's been declared so far, not what comes later). */
function expressionContext(state: ParserState | undefined): ExpressionParseContext {
  if (!state) return {};
  return { listMembers: state.listMembers, listDefinitions: state.listDefinitions };
}

/**
 * Strip an Ink `// line comment` (everything from `//` to EOL) but
 * leave the rest of the line intact. Tags (`# foo`) are NOT touched
 * here — `extractTags` handles those, and stripping them at this
 * level would also strip tags on knot-declaration lines that we want
 * to capture.
 */
function stripLineComment(line: string): string {
  const idx = line.indexOf('//');
  if (idx === -1) return line;
  // Trim trailing whitespace so the caller's regex doesn't have to
  // care whether there was a space before `//`.
  return line.slice(0, idx).trimEnd();
}

/**
 * Create implicit start node for content before first knot
 */
function createImplicitStartNode(state: ParserState): void {
  state.currentKnot = IMPLICIT_START_NODE;
  state.currentStitch = null;

  const node: StoryNode = {
    id: IMPLICIT_START_NODE,
    type: 'knot',
    parent: null,
    content: [],
    choices: [],
    divert: null,
    tags: [],
    lineNumber: 1,
  };

  state.nodes.set(IMPLICIT_START_NODE, node);
}

/**
 * Parse a single line of Ink
 */
function parseLine(line: string, state: ParserState, allLines: string[], lineIndex: number): void {
  // Strip `// line comments` first so they can't break the parsers
  // below — e.g. `== her == // notes for me` should still match as a
  // knot declaration (cause #1).
  const stripped = stripLineComment(line);
  const trimmed = stripped.trim();

  // Skip empty (and lines that were nothing but a comment).
  if (!trimmed) {
    return;
  }

  // INCLUDE statements: Ink splits stories across multiple files via
  // `INCLUDE foo.ink`. The API receives a single source string, so
  // we can't actually pull the file in here — but we MUST NOT silently
  // drop the line (the old parser would treat it as content). Emit a
  // warning and move on so the rest of the file still parses (  // cause #2).
  const includeMatch = trimmed.match(/^INCLUDE\s+(.+)$/);
  if (includeMatch) {
    state.warnings.push({
      type: 'syntax_error',
      message: `INCLUDE not supported on upload: "${includeMatch[1].trim()}". Concatenate the included content into a single .ink file, or upload the compiled JSON instead.`,
      lineNumber: state.lineNumber,
      args: { includePath: includeMatch[1].trim() },
    });
    return;
  }

  // VAR/CONST declaration (DEV-199 Phase 1).
  const variableDeclMatch = trimmed.match(VARIABLE_DECL_RE);
  if (variableDeclMatch) {
    parseVariableDeclarationLine(variableDeclMatch, state);
    return;
  }

  // LIST declaration (DEV-199 Phase 10).
  const listDeclMatch = trimmed.match(LIST_DECL_RE);
  if (listDeclMatch) {
    parseListDeclarationLine(listDeclMatch, state);
    return;
  }

  // Knot declaration (=== knot_name === or == knot_name ==, with
  // optional `function` keyword and optional trailing tag/comment).
  const knotMatch = trimmed.match(KNOT_DECL_RE);
  if (knotMatch) {
    const isFunction = !!knotMatch[1];
    const trailingTags = knotMatch[3] ? extractTags(knotMatch[3]).tags : [];
    parseKnot(knotMatch[2], state, isFunction, trailingTags);
    return;
  }

  // Stitch declaration (= stitch_name). Must start with single `=`
  // and not be `==` (which is a knot).
  const stitchMatch = trimmed.match(/^=\s*(\w+)\s*$/);
  if (stitchMatch && !trimmed.startsWith('==')) {
    parseStitch(stitchMatch[1], state);
    return;
  }

  // Standalone divert (-> target). Allow a leading `.` for relative
  // diverts (-> .stitch resolves to currentKnot.stitch). Also allow
  // the target to include dots for fully-qualified paths.
  const standaloneDiv = trimmed.match(/^->\s*(\.?\w+(?:\.\w+)?)\s*$/);
  if (standaloneDiv) {
    handleDivert(resolveDivertTarget(standaloneDiv[1], state), state);
    return;
  }

  // Choice (* or +) — handle indented choices too.
  const choiceMatch = trimmed.match(/^(\*|\+)/);
  if (choiceMatch) {
    parseChoice(trimmed, state, allLines, lineIndex);
    return;
  }

  // Gather (-)
  if (trimmed.startsWith('-') && !trimmed.startsWith('->')) {
    parseGather(trimmed, state);
    return;
  }

  // In-content assignment (~ statement — DEV-199 Phase 1).
  if (trimmed.startsWith('~')) {
    parseAssignmentLine(trimmed, state);
    return;
  }

  // Regular content line
  parseContent(trimmed, state);
}

/**
 * Rewrite bare targets that name a stitch inside the referring node's
 * own knot.
 *
 * Ink scopes a bare `-> read_email_5` inside a knot to that knot's
 * stitch, but resolveDivertTarget only handled the explicit dot form
 * (`-> .read_email_5`). Everything else kept the bare name while the
 * node itself is `<knot>.read_email_5`, so the two never matched. The
 * editor's target dropdown showed "(missing)", reachability never
 * walked into the stitch — reporting a whole run of passages as
 * unreachable — and audio coverage, which keys on node ids, treated
 * them as having none.
 *
 * The player masked all of it: navigateToTarget does this same
 * qualification at runtime, so the story played while the editor
 * insisted it was broken.
 *
 * Resolution order is deliberately EXACT MATCH FIRST, then the local
 * stitch. Strict Ink prefers the local stitch, but preferring the
 * exact match leaves every target that resolves today resolving to the
 * same node — this only touches targets that currently resolve to
 * nothing, so it can't change a working story.
 */
const TERMINAL_TARGETS = new Set(['END', 'DONE']);

export function resolveBareStitchTargets(nodes: Record<string, StoryNode>): void {
  const resolve = (target: string, fromNodeId: string): string => {
    if (!target || TERMINAL_TARGETS.has(target)) return target;
    // Already points at a real node — including a knot that shares its
    // name with a stitch. Leave it exactly as it is.
    //
    // Own-property checks, not `nodes[x]`: `constructor`, `toString`
    // and friends are legal Ink names under the parser's `\w+` rule,
    // and a plain object returns something truthy for all of them —
    // so a real `= constructor` stitch would look already-resolved and
    // never get qualified. build-service's gate already does this.
    if (Object.hasOwn(nodes, target)) return target;
    // The referring node's knot: its own id for a knot, the part
    // before the first dot for a stitch.
    const knot = fromNodeId.split('.')[0];
    const qualified = `${knot}.${target}`;
    return Object.hasOwn(nodes, qualified) ? qualified : target;
  };

  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const choice of node.choices ?? []) {
      choice.target = resolve(choice.target, nodeId);
    }
    if (node.divert) node.divert = resolve(node.divert, nodeId);
  }
}

/**
 * Resolve a divert target. `-> .stitch` inside a knot resolves to
 * `<currentKnot>.stitch` (cause #4). All other forms are
 * returned unchanged.
 */
function resolveDivertTarget(target: string, state: ParserState): string {
  if (target.startsWith('.') && state.currentKnot) {
    return `${state.currentKnot}.${target.slice(1)}`;
  }
  return target;
}

/**
 * Handle a divert - either standalone or following a choice
 */
function handleDivert(target: string, state: ParserState): void {
  const currentNode = getCurrentNode(state);

  if (currentNode && currentNode.choices.length > 0) {
    // Check if the last choice doesn't have a target yet (waiting for divert)
    const lastChoice = currentNode.choices[currentNode.choices.length - 1];
    if (lastChoice.target.startsWith('_') || lastChoice.target.includes('_choice_')) {
      // This divert belongs to the last choice
      lastChoice.target = target;
      return;
    }
  }

  // Otherwise, it's a standalone divert for the current node
  if (currentNode) {
    currentNode.divert = target;
  }
}

/**
 * Parse a knot declaration. `isFunction` flips on for `=== function
 * foo() ===`; we still create a node (so subsequent content lands on
 * the function knot and not on the previous knot) but tag it
 * `internal:function` so consumers can filter it from author-facing
 * UI (cause #3).
 */
function parseKnot(
  name: string,
  state: ParserState,
  isFunction = false,
  extraTags: string[] = [],
): void {
  state.currentKnot = name;
  state.currentStitch = null;

  if (state.nodes.has(name)) {
    state.errors.push({
      type: 'duplicate_node',
      message: `Duplicate knot name: ${name}`,
      nodeId: name,
      lineNumber: state.lineNumber,
      args: { nodeName: name, nodeKind: 'knot' },
    });
    return;
  }

  const node: StoryNode = {
    id: name,
    type: 'knot',
    parent: null,
    content: [],
    choices: [],
    divert: null,
    tags: [...(isFunction ? ['internal:function'] : []), ...extraTags],
    lineNumber: state.lineNumber,
  };

  state.nodes.set(name, node);
}

/**
 * Parse a stitch declaration
 */
function parseStitch(name: string, state: ParserState): void {
  if (!state.currentKnot) {
    state.errors.push({
      type: 'orphaned_stitch',
      message: `Stitch "${name}" declared outside of any knot`,
      lineNumber: state.lineNumber,
      args: { nodeName: name, nodeKind: 'stitch' },
    });
    return;
  }

  const fullId = `${state.currentKnot}.${name}`;
  state.currentStitch = name;

  if (state.nodes.has(fullId)) {
    state.errors.push({
      type: 'duplicate_node',
      message: `Duplicate stitch name: ${fullId}`,
      nodeId: fullId,
      lineNumber: state.lineNumber,
      args: { nodeName: fullId, nodeKind: 'stitch' },
    });
    return;
  }

  const node: StoryNode = {
    id: fullId,
    type: 'stitch',
    parent: state.currentKnot,
    content: [],
    choices: [],
    divert: null,
    tags: [],
    lineNumber: state.lineNumber,
  };

  state.nodes.set(fullId, node);
}

/**
 * Parse a choice line
 */
function parseChoice(
  line: string,
  state: ParserState,
  allLines: string[],
  lineIndex: number,
): void {
  const currentNode = getCurrentNode(state);
  if (!currentNode) {
    // Create implicit start node if we encounter a choice with no current node
    createImplicitStartNode(state);
    const newCurrentNode = getCurrentNode(state);
    if (!newCurrentNode) {
      state.warnings.push({
        type: 'syntax_error',
        message: 'Choice found outside of any node',
        lineNumber: state.lineNumber,
        args: { detail: 'orphan_choice' },
      });
      return;
    }
    parseChoiceIntoNode(line, newCurrentNode, state, allLines, lineIndex);
    return;
  }

  parseChoiceIntoNode(line, currentNode, state, allLines, lineIndex);
}

function parseChoiceIntoNode(
  line: string,
  currentNode: StoryNode,
  state: ParserState,
  allLines: string[],
  lineIndex: number,
): void {
  const trimmed = line.trim();
  const sticky = trimmed.startsWith('+');

  // Remove the choice marker (and any nested choice markers — we don't
  // use the nesting depth for anything yet, just strip them).
  let content = trimmed.substring(1).trim();
  while (content.startsWith('*') || content.startsWith('+')) {
    content = content.substring(1).trim();
  }

  // cause #5: choice labels — `* (label_name) text -> target`.
  // We don't model labels yet, but we MUST strip them or they leak
  // into the choice text. Capture for forward-compat.
  let label: string | null = null;
  const labelMatch = content.match(/^\(([\w-]+)\)\s*/);
  if (labelMatch) {
    label = labelMatch[1];
    content = content.slice(labelMatch[0].length);
  }

  // Conditional choice visibility (DEV-199 Phase 4): one or more
  // `{condition}` prefixes right after the marker/label — NOT the
  // `{condition: text}` form, which is conditional TEXT (Phase 3) and
  // only applies to content lines. Ink's `{c1}{c2}` stacked prefixes
  // AND together into one expression (see the plan's architecture
  // note on Choice.condition being singular, never a list).
  let condition: Expression | undefined;
  let conditionMatch: RegExpMatchArray | null;
  while ((conditionMatch = content.match(/^\{([^{}]+)\}\s*/))) {
    try {
      const parsed = parseExpression(conditionMatch[1].trim(), expressionContext(state));
      condition = condition
        ? { kind: 'logical', operator: '&&', left: condition, right: parsed }
        : parsed;
      content = content.slice(conditionMatch[0].length);
    } catch (err) {
      state.warnings.push({
        type: 'syntax_error',
        message: `Could not parse choice condition "${conditionMatch[1].trim()}": ${errorMessage(err)}`,
        lineNumber: state.lineNumber,
        args: { detail: conditionMatch[1].trim() },
      });
      // Leave this (and any further) `{...}` prefix as literal text
      // rather than risk an infinite loop re-matching the same
      // unparseable prefix.
      break;
    }
  }

  // Extract tags
  const { text, tags } = extractTags(content);

  // Check for inline divert (on the same line). Allow leading-dot
  // relative targets (`-> .stitch`).
  const inlineDivertMatch = text.match(/^(.+?)\s*->\s*(\.?\w+(?:\.\w+)?)\s*$/);
  let choiceText = text;
  let target = '';

  if (inlineDivertMatch) {
    choiceText = inlineDivertMatch[1].trim();
    target = resolveDivertTarget(inlineDivertMatch[2], state);
  }

  // Handle square bracket syntax for choice text vs output text
  // [choice text] output text or choice text [output text]
  const bracketMatch = choiceText.match(/^\[([^\]]*)\]\s*(.*)$|^([^[]*)\[([^\]]*)\]$/);
  if (bracketMatch) {
    // [text] format - just use what's in brackets
    choiceText = (bracketMatch[1] || bracketMatch[3] || choiceText).trim();
  }

  // If no inline divert, check if the next non-empty line is a divert.
  // When the look-ahead consumes a divert, mark its line index so the
  // main parse loop skips it — otherwise the next iteration would
  // re-process the same `-> target` and attach it to the parent knot
  // as a fall-through divert.
  if (!target) {
    const look = lookAheadForDivert(allLines, lineIndex);
    if (look.target) {
      target = resolveDivertTarget(look.target, state);
      state.consumedLines.add(look.consumedAt);
    }
  }

  // If still no target, create a placeholder
  if (!target) {
    target = `${currentNode.id}_choice_${currentNode.choices.length}`;
  }

  const choice: Choice = {
    id: randomUUID(),
    text: choiceText.trim(),
    target,
    sticky,
    fallback: false,
    tags: label ? [...tags, `internal:label:${label}`] : tags,
    ...(condition !== undefined ? { condition } : {}),
  };

  currentNode.choices.push(choice);
}

/**
 * Look ahead in the source to find a divert on the next non-empty line.
 * Returns the target plus the source line index it was found on so the
 * caller can mark that line as already-consumed — otherwise the main
 * parse loop would re-process the divert as if it belonged to the
 * parent knot, leaving e.g. `tell_you.divert = infinite_grace` when
 * the `-> infinite_grace` actually belongs to a choice.
 */
function lookAheadForDivert(
  allLines: string[],
  currentIndex: number,
): { target: string; consumedAt: number } {
  for (let i = currentIndex + 1; i < allLines.length; i++) {
    const trimmed = stripLineComment(allLines[i]).trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Check if it's a standalone divert (possibly indented). Allow a
    // leading `.` for relative diverts (`-> .stitch`); the caller
    // resolves the final target via resolveDivertTarget.
    const divertMatch = trimmed.match(/^->\s*(\.?\w+(?:\.\w+)?)\s*$/);
    if (divertMatch) {
      return { target: divertMatch[1], consumedAt: i };
    }

    // If it's not a divert, stop looking (could be content, another choice, etc.)
    break;
  }
  return { target: '', consumedAt: -1 };
}

/**
 * Parse a gather point
 */
function parseGather(line: string, state: ParserState): void {
  // Gathers merge multiple choice paths back together
  // For now, we treat content after gather as continuing in the current node
  let content = line.replace(/^-+\s*/, '').trim();
  // cause #5: gather labels — `- (label) content`. Strip them
  // so they don't leak into the gather's text content.
  content = content.replace(/^\([\w-]+\)\s*/, '');
  if (content) {
    parseContent(content, state);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a `VAR name = expr` / `CONST name = expr` declaration into
 * `state.variables`. Ink has no separate type annotation — the type
 * is inferred from the initializer, which may itself reference an
 * earlier declaration (`VAR b = a * 2`), so this evaluates against
 * `state.variableValues` (built up incrementally, in file order)
 * rather than requiring a literal.
 *
 * Any failure (unparseable expression, or one that can't be
 * evaluated yet — e.g. it references a variable not yet declared)
 * is reported as a warning and the declaration is skipped, rather
 * than failing the whole parse.
 */
function parseVariableDeclarationLine(match: RegExpMatchArray, state: ParserState): void {
  const [, keyword, name, rhsRaw] = match;
  const isConst = keyword === 'CONST';

  // A VAR/CONST sharing a name with an already-declared LIST's member
  // would make every later bare reference to that name resolve as
  // the list member (parsePrimary checks listMemberInfo first), not
  // this declaration — permanently shadowing it with no warning.
  const collidingMember = state.listMembers[name];
  if (collidingMember) {
    state.warnings.push({
      type: 'syntax_error',
      message: `${keyword} ${name} collides with a member of LIST ${collidingMember.origin}`,
      lineNumber: state.lineNumber,
      args: { name, keyword },
    });
    return;
  }
  // A VAR/CONST sharing a name with an already-declared LIST's OWN
  // name is the same hazard in the other direction — the LIST's name
  // is itself a valid reference to its full initial-value literal.
  if (Object.hasOwn(state.listDefinitions, name)) {
    state.warnings.push({
      type: 'syntax_error',
      message: `${keyword} ${name} collides with an already-declared LIST of the same name`,
      lineNumber: state.lineNumber,
      args: { name, keyword },
    });
    return;
  }

  let initialValue: Expression;
  try {
    initialValue = parseExpression(rhsRaw.trim(), expressionContext(state));
  } catch (err) {
    state.warnings.push({
      type: 'syntax_error',
      message: `Could not parse ${keyword} ${name}'s initial value: ${errorMessage(err)}`,
      lineNumber: state.lineNumber,
      args: { name, keyword },
    });
    return;
  }

  let value: VariableValue;
  try {
    value = evaluate(initialValue, state.variableValues);
  } catch (err) {
    state.warnings.push({
      type: 'syntax_error',
      message: `Could not determine a type for ${keyword} ${name}: ${errorMessage(err)}`,
      lineNumber: state.lineNumber,
      args: { name, keyword },
    });
    return;
  }

  const type: VariableType = isListValue(value)
    ? 'list'
    : typeof value === 'number'
      ? 'number'
      : typeof value === 'boolean'
        ? 'bool'
        : 'string';
  state.variables.push({ name, type, initialValue, isConst });
  state.variableValues[name] = value;
}

/**
 * Parse a `LIST name = member1, (member2), member3` declaration
 * (DEV-199 Phase 10). Parens around a member mark it initially
 * active; everything else in `state.listMembers`/`listDefinitions`
 * exists so a bare member name in a LATER expression/statement
 * resolves as a list literal rather than an undeclared-variable
 * reference — see `expressionContext`.
 */
function parseListDeclarationLine(match: RegExpMatchArray, state: ParserState): void {
  const [, name, rhsRaw] = match;

  // The LIST's own name must not collide with an already-declared
  // VAR/CONST, another LIST's own name (a LIST's own name is ALSO
  // registered in state.variableValues below, the same as any VAR —
  // it resolves as a plain variable reference everywhere outside
  // listMembers, so one check against variableValues covers both),
  // or another LIST's member — each of those already claims `name`
  // as a valid bare reference, and silently letting this declaration
  // win would permanently shadow whichever one came first with no
  // warning.
  if (Object.hasOwn(state.variableValues, name)) {
    state.warnings.push({
      type: 'syntax_error',
      message: `LIST ${name} collides with an already-declared variable of the same name`,
      lineNumber: state.lineNumber,
      args: { name },
    });
    return;
  }
  const collidingOwnName = state.listMembers[name];
  if (collidingOwnName) {
    state.warnings.push({
      type: 'syntax_error',
      message: `LIST ${name} collides with a member of LIST ${collidingOwnName.origin}`,
      lineNumber: state.lineNumber,
      args: { name },
    });
    return;
  }

  const memberTokens = rhsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (memberTokens.length === 0) {
    state.warnings.push({
      type: 'syntax_error',
      message: `LIST ${name} declares no members`,
      lineNumber: state.lineNumber,
      args: { name },
    });
    return;
  }

  const allItems: ListItem[] = [];
  const activeNames: string[] = [];
  for (let i = 0; i < memberTokens.length; i++) {
    let token = memberTokens[i];
    const active = token.startsWith('(') && token.endsWith(')');
    if (active) token = token.slice(1, -1).trim();
    if (!/^[A-Za-z_]\w*$/.test(token)) {
      state.warnings.push({
        type: 'syntax_error',
        message: `LIST ${name}: "${token}" is not a valid member name`,
        lineNumber: state.lineNumber,
        args: { name, member: token },
      });
      return;
    }
    // A member name that collides with an already-declared VAR/CONST,
    // or with a member of a DIFFERENT already-declared LIST, would
    // otherwise silently overwrite the earlier declaration's claim on
    // that bare identifier in state.listMembers/variableValues — any
    // later reference to the name would then resolve against the
    // wrong origin with no warning (real Ink itself rejects this at
    // compile time as a duplicate definition).
    if (Object.hasOwn(state.variableValues, token)) {
      state.warnings.push({
        type: 'syntax_error',
        message: `LIST ${name}: member "${token}" collides with an already-declared variable of the same name`,
        lineNumber: state.lineNumber,
        args: { name, member: token },
      });
      return;
    }
    // A member colliding with another already-declared LIST's OWN
    // name is already caught by the variableValues check above —
    // that LIST's name is registered there too, the same as any VAR.
    const existingMember = state.listMembers[token];
    if (existingMember && existingMember.origin !== name) {
      state.warnings.push({
        type: 'syntax_error',
        message: `LIST ${name}: member "${token}" collides with a member of LIST ${existingMember.origin}`,
        lineNumber: state.lineNumber,
        args: { name, member: token },
      });
      return;
    }
    allItems.push({ name: token, ordinal: i });
    if (active) activeNames.push(token);
  }

  // Register every member BEFORE building the initial-value literal,
  // so a member can reference an earlier member of the SAME
  // declaration — not meaningful for list literals themselves, but
  // keeps this consistent with how VAR/CONST registers incrementally.
  for (const item of allItems) {
    state.listMembers[item.name] = { origin: name, ordinal: item.ordinal };
  }
  state.listDefinitions[name] = allItems;

  const activeItems = allItems.filter((item) => activeNames.includes(item.name));
  const value: VariableValue = { kind: 'list', origin: name, items: activeItems, allItems };
  const initialValue: Expression = { kind: 'literal', value };
  state.variables.push({
    name,
    type: 'list',
    initialValue,
    isConst: false,
    listMembers: allItems.map((item) => item.name),
  });
  state.variableValues[name] = value;
}

/**
 * Parse an in-content `~ statement` line (DEV-199 Phase 1) into an
 * AssignmentBlock, interleaved with surrounding TextBlocks in
 * document order on the current node.
 *
 * Only `name <assignOp> expr` is understood yet — Ink's `~ return`,
 * `~ temp x = ...`, `~ x++`/`~ x--`, and bare function calls are not
 * (see expression-parser.ts's header). Falling back to plain content
 * on a parse failure matches this parser's pre-DEV-199 behavior for
 * every `~` line (none were understood then either), so an
 * unsupported form still shows up for the author to notice and fix,
 * rather than silently vanishing.
 */
function parseAssignmentLine(trimmedLine: string, state: ParserState): void {
  // `trimmedLine` still has its leading `~` — strip it here (rather
  // than at the call site) so the fallback below can re-emit the
  // EXACT original line on a parse failure, whitespace included,
  // instead of a reconstruction that could drift from what the
  // author actually wrote (e.g. `~return x` with no space).
  const rest = trimmedLine.slice(1).trim();
  let statement: Statement;
  try {
    statement = parseStatement(rest, expressionContext(state));
  } catch (err) {
    state.warnings.push({
      type: 'syntax_error',
      message: `Could not parse assignment "${trimmedLine}": ${errorMessage(err)}`,
      lineNumber: state.lineNumber,
      args: { detail: rest },
    });
    parseContent(trimmedLine, state);
    return;
  }

  let currentNode = getCurrentNode(state);
  if (!currentNode) {
    createImplicitStartNode(state);
    currentNode = getCurrentNode(state);
  }
  currentNode?.content.push({ id: randomUUID(), kind: 'assignment', statement });
}

/**
 * Parse content text
 */
function parseContent(line: string, state: ParserState): void {
  const currentNode = getCurrentNode(state);
  if (!currentNode) {
    // Content before any knot - create implicit start
    createImplicitStartNode(state);
    const newNode = getCurrentNode(state);
    if (newNode) {
      addContentToNode(line, newNode, state);
    }
    return;
  }

  addContentToNode(line, currentNode, state);
}

// Ink conditional text (DEV-199 Phase 3): `{condition: text}` wrapping
// an entire content line. Only this single-condition form is
// supported — Ink's `{a|b}` alternatives/sequences (cycles, shuffles,
// once-only lists) are a different feature and stay unsupported
// (unmatched here, so they fall through as inert text exactly as they
// did before this phase, which is not a regression).
const CONDITIONAL_TEXT_RE = /^\{([^{}]+?):(.*)\}$/;

function addContentToNode(line: string, node: StoryNode, state?: ParserState): void {
  const { text, tags } = extractTags(line);

  let innerText = text;
  let condition: Expression | undefined;
  const conditionalMatch = text.match(CONDITIONAL_TEXT_RE);
  if (conditionalMatch) {
    try {
      condition = parseExpression(conditionalMatch[1].trim(), expressionContext(state));
      innerText = conditionalMatch[2].trim();
    } catch (err) {
      if (state) {
        state.warnings.push({
          type: 'syntax_error',
          message: `Could not parse conditional text's condition "${conditionalMatch[1].trim()}": ${errorMessage(err)}`,
          lineNumber: state.lineNumber,
          args: { detail: conditionalMatch[1].trim() },
        });
      }
      // Fall through with innerText still the whole original line —
      // same tolerant-degradation choice as the ~ assignment fallback.
    }
  }

  // Check for inline divert. Allow leading-dot relative targets.
  let finalText = innerText;
  const divertMatch = innerText.match(/^(.+?)\s*->\s*(\.?\w+(?:\.\w+)?)\s*$/);
  if (divertMatch) {
    finalText = divertMatch[1].trim();
    if (!node.divert) {
      node.divert = state ? resolveDivertTarget(divertMatch[2], state) : divertMatch[2];
    }
  }

  // Add tags to node if on their own line
  if (!finalText && tags.length > 0) {
    node.tags.push(...tags);
    return;
  }

  if (finalText) {
    const content: TextContent = {
      id: randomUUID(),
      kind: 'text',
      text: finalText,
      tags,
      ...(condition !== undefined ? { condition } : {}),
    };
    node.content.push(content);
  }
}

/**
 * Extract tags from a line (# tag syntax)
 */
function extractTags(line: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  let text = line;

  // Match all # tags
  const tagRegex = /#\s*([^#\n]+)/g;
  let match;

  while ((match = tagRegex.exec(line)) !== null) {
    tags.push(match[1].trim());
  }

  // Remove tags from text
  text = line.replace(/#[^#\n]*/g, '').trim();

  return { text, tags };
}

/**
 * Get the current node being parsed
 */
function getCurrentNode(state: ParserState): StoryNode | null {
  if (state.currentStitch && state.currentKnot) {
    const id = `${state.currentKnot}.${state.currentStitch}`;
    return state.nodes.get(id) || null;
  }
  if (state.currentKnot) {
    return state.nodes.get(state.currentKnot) || null;
  }
  return null;
}

/**
 * Find the start node of the story
 */
function findStartNode(nodes: Record<string, StoryNode>): string {
  // Look for a knot named "start" first
  if (nodes['start']) {
    return 'start';
  }

  // Check for implicit intro node
  if (nodes[IMPLICIT_START_NODE]) {
    return IMPLICIT_START_NODE;
  }

  // Otherwise, use the first knot defined
  const knots = Object.values(nodes).filter((n) => n.type === 'knot');
  if (knots.length > 0) {
    // Sort by line number to get the first one
    knots.sort((a, b) => a.lineNumber - b.lineNumber);
    return knots[0].id;
  }

  return '';
}

/**
 * Extract title from Ink source (looks for # title tag or INCLUDE)
 */
function extractTitle(source: string): string | null {
  // Look for title tag
  const titleMatch = source.match(/^#\s*title:\s*(.+)$/m);
  if (titleMatch) {
    return titleMatch[1].trim();
  }
  return null;
}

/**
 * Validate the story graph
 */
function validateGraph(
  nodes: Record<string, StoryNode>,
  startNode: string,
  existingErrors: ValidationMessage[],
  existingWarnings: ValidationMessage[],
): ValidationResult {
  const errors: ValidationMessage[] = [...existingErrors];
  const warnings: ValidationMessage[] = [...existingWarnings];

  // Check for missing start node
  if (!startNode || !nodes[startNode]) {
    errors.push({
      type: 'missing_start',
      message:
        'No start node found. Create a knot named "start" or ensure at least one knot exists.',
      args: { expectedStart: 'start', nodeKind: 'knot' },
    });
  }

  // Check for missing divert/choice targets
  const allTargets = new Set<string>();
  Object.values(nodes).forEach((node) => {
    if (node.divert) {
      allTargets.add(node.divert);
    }
    node.choices.forEach((choice) => {
      if (choice.target && !choice.target.startsWith('_') && !choice.target.includes('_choice_')) {
        allTargets.add(choice.target);
      }
    });
  });

  // Built-in Ink targets that don't need to be defined
  const builtInTargets = new Set(['END', 'DONE']);

  allTargets.forEach((target) => {
    // Skip built-in targets
    if (builtInTargets.has(target)) {
      return;
    }

    // Handle both full paths and relative paths
    if (!nodes[target]) {
      // Try to resolve relative paths (stitch within current knot)
      const possiblePaths = Object.keys(nodes).filter(
        (id) => id === target || id.endsWith(`.${target}`),
      );
      if (possiblePaths.length === 0) {
        warnings.push({
          type: 'missing_target',
          message: `Divert target "${target}" not found`,
          args: { targetName: target },
        });
      }
    }
  });

  // Check for unreachable nodes
  const reachable = new Set<string>();
  if (startNode && nodes[startNode]) {
    findReachableNodes(startNode, nodes, reachable);
  }

  Object.keys(nodes).forEach((nodeId) => {
    if (!reachable.has(nodeId)) {
      // Don't warn about stitches - they're reachable from their parent knot
      if (!nodeId.includes('.')) {
        warnings.push({
          type: 'unreachable_node',
          message: `Node "${nodeId}" is not reachable from the start`,
          nodeId,
          lineNumber: nodes[nodeId].lineNumber,
          args: { nodeName: nodeId, nodeKind: nodes[nodeId].type ?? 'knot' },
        });
      }
    }
  });

  // Check for empty nodes. A knot whose payload lives entirely in
  // its stitches (e.g. `== credits == / = actual_credits / ... ->
  // END`) is NOT empty from the author's POV — Ink semantics say
  // entering the knot runs the first stitch. Skip those.
  const knotHasStitch = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.type === 'stitch' && node.parent) knotHasStitch.add(node.parent);
  }
  Object.values(nodes).forEach((node) => {
    if (node.id === IMPLICIT_START_NODE && node.choices.length > 0) {
      return; // Implicit intro with choices is fine
    }
    if (node.type === 'knot' && knotHasStitch.has(node.id)) {
      return; // Knot delegates to its stitches — not empty.
    }
    if (node.content.length === 0 && node.choices.length === 0 && !node.divert) {
      warnings.push({
        type: 'empty_node',
        message: `Node "${node.id}" has no content, choices, or divert`,
        nodeId: node.id,
        lineNumber: node.lineNumber,
        args: { nodeName: node.id, nodeKind: node.type ?? 'knot' },
      });
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Find all nodes reachable from a starting node
 */
function findReachableNodes(
  nodeId: string,
  nodes: Record<string, StoryNode>,
  reachable: Set<string>,
): void {
  if (reachable.has(nodeId) || !nodes[nodeId]) {
    return;
  }

  reachable.add(nodeId);
  const node = nodes[nodeId];

  // Follow diverts
  if (node.divert) {
    // Handle both direct targets and relative paths
    if (nodes[node.divert]) {
      findReachableNodes(node.divert, nodes, reachable);
    } else {
      // Try to find relative path
      const matches = Object.keys(nodes).filter((id) => id.endsWith(`.${node.divert}`));
      matches.forEach((match) => findReachableNodes(match, nodes, reachable));
    }
  }

  // Follow choices
  node.choices.forEach((choice) => {
    if (choice.target) {
      if (nodes[choice.target]) {
        findReachableNodes(choice.target, nodes, reachable);
      } else {
        // Try to find relative path
        const matches = Object.keys(nodes).filter((id) => id.endsWith(`.${choice.target}`));
        matches.forEach((match) => findReachableNodes(match, nodes, reachable));
      }
    }
  });

  // Include stitches within a knot
  if (node.type === 'knot') {
    Object.keys(nodes).forEach((id) => {
      if (id.startsWith(`${nodeId}.`)) {
        findReachableNodes(id, nodes, reachable);
      }
    });
  }
}
