/**
 * Twee 3 emitter.
 *
 * Reverse of `parseTwee` — takes a StoryGraph and produces a Twee 3
 * source string. Used for:
 *   - The on-demand export endpoint (Phase 2).
 *   - Regenerating the authoritative source after a node-detail edit
 *     when source_language='twee' (Phase 2).
 *   - Round-trip tests (`emit(parse(source)) === source` modulo
 *     whitespace normalisation).
 *
 * Emit shape:
 *   :: StoryTitle
 *   <title>
 *
 *   :: StoryData
 *   {"start":"<startPassageId>"}
 *
 *   :: <PassageName> [tag1 tag2]
 *   <content paragraphs, blank-line separated>
 *
 *   [[Choice text->Target]]
 *   [[Text|Target]]      (used when text == target we emit [[Target]])
 *
 * Content-body escape: any line beginning with `::` needs escaping so
 * it doesn't start a new passage on re-parse; we prepend `\`.
 */

import type { StoryGraph, StoryNode, Choice, ContentBlock, TweeDialect } from '../types.js';
import { renderHarloweExpression, renderHarloweAssignment } from './harlowe-macros.js';
import { renderSugarCubeExpression, renderSugarCubeAssignment } from './sugarcube-macros.js';
import { renderChapbookExpression, renderChapbookAssignment } from './chapbook-macros.js';

/**
 * Escape passage names for embedding in a link target. Twee 3 doesn't
 * define a formal escape scheme, but `]` and `|` inside a link would
 * corrupt the parse — pass through unchanged for names that don't
 * contain them, or refuse-and-log if they do. In practice a name
 * with `]` or `|` would have been rejected at import time.
 */
function isLinkSafe(name: string): boolean {
  return (
    !name.includes(']') &&
    !name.includes('|') &&
    !name.includes('[') &&
    !name.includes('->') &&
    !name.includes('<-')
  );
}

/**
 * The choice DISPLAY TEXT sits on the left side of `[[Text|Target]]`.
 * Twee 3 has no defined escape mechanism, so any of the delimiters
 * `|`, `->`, `<-`, `[`, `]` inside the text would corrupt round-trip:
 * `Choice { text: 'A|B', target: 'Home' }` emits `[[A|B|Home]]` and
 * re-parses as `text='A', target='B|Home'`. Guard so the emitter
 * fails loudly instead of silently mangling the graph.
 */
function isChoiceTextSafe(text: string): boolean {
  return (
    !text.includes(']') &&
    !text.includes('[') &&
    !text.includes('|') &&
    !text.includes('->') &&
    !text.includes('<-')
  );
}

/**
 * Emit a single choice's link as `[[Text|Target]]`, collapsing to
 * `[[Target]]` when text and target coincide (matches the source
 * most Twee editors produce and keeps the round-trip byte-shorter
 * for the common case).
 *
 * Throws on unsafe target names (containing `[`, `]`, or `|`). The
 * parser rejects such names at import time — see the same-named
 * check in twee-parser.ts — so this branch should be unreachable in
 * practice. Fail loudly instead of silently producing malformed
 * Twee that can't be re-parsed.
 */
function emitChoiceLink(choice: Choice): string {
  if (!isLinkSafe(choice.target)) {
    throw new Error(
      `Cannot emit Twee link — target "${choice.target}" contains an unsupported character (\`[\`, \`]\`, \`|\`, \`->\`, or \`<-\`). Rename the target passage first.`,
    );
  }
  if (choice.text === choice.target) return `[[${choice.target}]]`;
  if (!isChoiceTextSafe(choice.text)) {
    throw new Error(
      `Cannot emit Twee link — display text "${choice.text}" contains an unsupported character (\`[\`, \`]\`, \`|\`, \`->\`, or \`<-\`). Edit the choice text before exporting.`,
    );
  }
  return `[[${choice.text}|${choice.target}]]`;
}

/**
 * Emit a choice, wrapping its link in a `(if: COND)[...]` hook,
 * SugarCube's `<<if COND>>...<</if>>` block, or Chapbook's
 * `[if COND]`/`[continue]` modifier pair, when it carries a condition
 * (DEV-199 Phase 4/7/8/9) AND the graph's dialect actually understands
 * one of those forms. A condition on a graph with no resolved dialect
 * has no Twee macro/modifier form to emit into at all — the condition
 * is silently dropped rather than emitted as something that wouldn't
 * parse back, same conservative choice this emitter already makes
 * for assignment blocks.
 *
 * Chapbook's `[continue]` immediately after resets the modifier state
 * back to unconditional, so this condition can never "leak" onto
 * whatever paragraph gets emitted next — each conditioned
 * choice/block is wrapped independently rather than reconstructed
 * into a compact if/else chain, the same simplification Harlowe's and
 * SugarCube's emitters already make.
 */
function emitChoice(
  choice: Choice,
  dialect: TweeDialect | undefined,
  listVariableNames: ReadonlySet<string>,
): string {
  const link = emitChoiceLink(choice);
  if (!choice.condition) return link;
  if (dialect === 'harlowe') {
    return `(if: ${renderHarloweExpression(choice.condition, listVariableNames)})[${link}]`;
  }
  if (dialect === 'sugarcube') {
    return `<<if ${renderSugarCubeExpression(choice.condition, listVariableNames)}>>${link}<</if>>`;
  }
  if (dialect === 'chapbook') {
    return `[if ${renderChapbookExpression(choice.condition, listVariableNames)}]\n${link}\n\n[continue]`;
  }
  return link;
}

/**
 * Escape a content line that would otherwise start a new passage on
 * re-parse. Twee doesn't have a formal `::` escape, but `\::` at the
 * start of a line is a common convention (the parser here treats a
 * leading `\:` as literal). Also prevents accidental `::` from a
 * paragraph body colliding with a header.
 */
function escapeContentLine(line: string): string {
  if (line.startsWith('::')) return '\\' + line;
  return line;
}

function emitPassage(
  name: string,
  tags: string[],
  body: string,
  metadata?: Record<string, unknown>,
): string {
  const parts: string[] = [`:: ${name}`];
  if (tags.length) parts.push(`[${tags.join(' ')}]`);
  if (metadata && Object.keys(metadata).length > 0) parts.push(JSON.stringify(metadata));
  const header = parts.join(' ');
  // run every body line through escapeContentLine so a
  // caller-supplied body (e.g. StoryTitle with a `:: X` line in it)
  // can't accidentally start a new passage on re-parse.
  const safeBody = body.split('\n').map(escapeContentLine).join('\n');
  return `${header}\n${safeBody}\n`;
}

/**
 * Render one content block for emission, or null when it contributes
 * nothing (an empty text block, or an assignment/condition this
 * dialect has no macro form for yet). Escaping happens once, at
 * emitPassage — don't double-escape here (`\::` would become `\\::`
 * and the parser's unescape leaves a stray backslash).
 */
function emitContentBlock(
  content: ContentBlock,
  dialect: TweeDialect | undefined,
  listVariableNames: ReadonlySet<string>,
): string | null {
  if (content.kind === 'assignment') {
    // Harlowe re-emits as `(set: ...)`, SugarCube as `<<set ...>>`.
    // Chapbook assignments are hoisted into a leading vars section by
    // emitContent below instead of rendered inline here (Chapbook's
    // vars section is a whole-passage block, not an inline macro) —
    // return null so this generic per-block path doesn't ALSO try to
    // emit them. A graph with no resolved dialect still has no Twee
    // prose to put an assignment block into at all.
    if (dialect === 'harlowe') return renderHarloweAssignment(content.statement, listVariableNames);
    if (dialect === 'sugarcube')
      return renderSugarCubeAssignment(content.statement, listVariableNames);
    return null;
  }
  const text = content.text.trim();
  if (!text) return null;
  if (content.condition) {
    if (dialect === 'harlowe') {
      return `(if: ${renderHarloweExpression(content.condition, listVariableNames)})[${text}]`;
    }
    if (dialect === 'sugarcube') {
      return `<<if ${renderSugarCubeExpression(content.condition, listVariableNames)}>>${text}<</if>>`;
    }
    if (dialect === 'chapbook') {
      return `[if ${renderChapbookExpression(content.condition, listVariableNames)}]\n${text}\n\n[continue]`;
    }
  }
  // Same conservative choice as emitChoice above: a condition on a
  // graph with no resolved dialect has no Twee macro/modifier form to
  // emit into, so it's dropped — the text itself still emits,
  // UNCONDITIONALLY, rather than vanishing entirely or emitting
  // something that wouldn't parse back. An Ink-authored
  // conditionally-gated passage exported as plain Twee (no dialect)
  // loses that gating.
  return text;
}

function emitContent(
  node: StoryNode,
  dialect: TweeDialect | undefined,
  listVariableNames: ReadonlySet<string>,
): string {
  const paragraphs = node.content
    .map((c) => emitContentBlock(c, dialect, listVariableNames))
    .filter((s): s is string => s !== null);
  const choices = node.choices.map((c) => emitChoice(c, dialect, listVariableNames));
  // forward node.divert. An Ink-authored graph with an
  // implicit continuation (`-> kitchen`) has choices=[] and
  // divert='kitchen'. Without emitting the divert, the exported Twee
  // dead-ends at that passage. Emit the divert as a `[[Target]]`
  // link — Twine's own tools treat a single-link passage as an
  // auto-continuation, so this is the closest round-trip. END/DONE
  // are Ink built-ins with no Twee equivalent; drop them, since a
  // Twee passage with no links + no continuation reads as an ending.
  const divert =
    node.divert && node.divert !== 'END' && node.divert !== 'DONE' && isLinkSafe(node.divert)
      ? [`[[${node.divert}]]`]
      : [];
  // Join content + choices + divert on double newlines so the
  // round-trip parse sees each as its own paragraph and links land
  // on their own lines (matches the shape most Twine editors
  // produce).
  const body = [...paragraphs, ...choices, ...divert].join('\n\n');

  if (dialect === 'chapbook') {
    // Chapbook's vars section is a whole-passage block at the very
    // TOP, not an inline macro — hoist every assignment block here
    // (emitContentBlock already returned null for them above) rather
    // than interleaving them with the displayed text.
    const varsLines = node.content
      .filter((c) => c.kind === 'assignment')
      .map((c) => renderChapbookAssignment(c.statement, listVariableNames));
    if (varsLines.length > 0) {
      return `${varsLines.join('\n')}\n--${body ? `\n${body}` : ''}`;
    }
  }
  return body;
}

/**
 * Emit a Twee 3 source string from a StoryGraph. Deterministic
 * ordering: StoryTitle → StoryData → start passage → other passages
 * in alphabetical order by id. Deterministic order matters for the
 * round-trip test and for git diffs of the emit-cached column.
 */
export function emitTwee(graph: StoryGraph): string {
  const blocks: string[] = [];

  // DEV-199 Phase 10: Harlowe/SugarCube/Chapbook have no LIST
  // equivalent. A bare `{kind:'variable'}` reference gives the
  // renderers no way to tell a LIST-typed variable from any other —
  // this is the set they check against to reject one instead of
  // mis-rendering `$kettleState` as if it held a plain scalar.
  const listVariableNames = new Set(
    (graph.variables ?? []).filter((v) => v.type === 'list').map((v) => v.name),
  );

  if (graph.title && graph.title !== 'Untitled') {
    blocks.push(emitPassage('StoryTitle', [], graph.title));
  }

  // Only emit StoryData when we have a real start that actually
  // resolves to a passage. `graph.nodes` came back through JSONB
  // round-trip so it's a plain object — a bare `in graph.nodes`
  // check would be true for `Object.prototype` keys like `toString`
  // and cause a runtime crash below when `graph.nodes[id]` is a
  // function, not a StoryNode. Use `Object.hasOwn` for both this
  // gate and the orderedIds seed below so start selection stays
  // prototype-safe.
  const startExists = !!graph.startNode && Object.hasOwn(graph.nodes, graph.startNode);
  if (startExists) {
    // preserve every StoryData field the upload carried
    // (ifid, format, format-version, tag-colors, zoom, ...) so a
    // Twee → graph → Twee round-trip doesn't strip metadata that
    // Twine's own tools need to open the file. `start` is always
    // overwritten from the current graph so a graph edit that
    // changes the start passage still exports correctly.
    const meta: Record<string, unknown> = {
      ...(graph.twee?.storyData ?? {}),
      start: graph.startNode,
    };
    blocks.push(emitPassage('StoryData', [], JSON.stringify(meta)));
  }

  // re-emit special-passage bodies (StoryInit / PassageHeader
  // / PassageFooter / etc.) so authoring wrappers survive a graph
  // mutation. Sorted for determinism.
  if (graph.twee?.specials) {
    const specialNames = Object.keys(graph.twee.specials).sort();
    for (const name of specialNames) {
      const body = graph.twee.specials[name];
      if (typeof body === 'string' && body.length > 0) {
        blocks.push(emitPassage(name, [], body));
      }
    }
  }

  // Start passage first, then everything else alphabetically. Skip
  // the start-passage-in-alphabetical pass so we don't duplicate.
  const passageIds = Object.keys(graph.nodes).sort();
  const orderedIds: string[] = [];
  if (startExists) {
    orderedIds.push(graph.startNode);
  }
  for (const id of passageIds) {
    if (id !== graph.startNode) orderedIds.push(id);
  }

  for (const id of orderedIds) {
    const node = graph.nodes[id];
    blocks.push(
      emitPassage(
        id,
        node.tags,
        emitContent(node, graph.twee?.dialect, listVariableNames),
        node.metadata,
      ),
    );
  }

  return blocks.join('\n');
}
