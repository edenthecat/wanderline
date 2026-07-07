/**
 * Ink Parser Service
 * Parses .ink files into the Wanderline story graph format
 */

import type {
  StoryGraph,
  StoryNode,
  TextContent,
  Choice,
  ValidationResult,
  ValidationMessage,
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

  // Convert Map to Record
  const nodes: Record<string, StoryNode> = {};
  state.nodes.forEach((node, id) => {
    nodes[id] = node;
  });

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

  // Regular content line
  parseContent(trimmed, state);
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
    text: choiceText.trim(),
    target,
    sticky,
    fallback: false,
    tags: label ? [...tags, `internal:label:${label}`] : tags,
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

function addContentToNode(line: string, node: StoryNode, state?: ParserState): void {
  const { text, tags } = extractTags(line);

  // Check for inline divert. Allow leading-dot relative targets.
  let finalText = text;
  const divertMatch = text.match(/^(.+?)\s*->\s*(\.?\w+(?:\.\w+)?)\s*$/);
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
      text: finalText,
      tags,
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
