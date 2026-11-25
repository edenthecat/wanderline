/**
 * Converts a story graph back to Ink format.
 * Extracted from projects.ts for reuse.
 */

import { printExpression, printStatement, isListValue } from '@wanderline/shared';
import type { ContentBlock, Expression, VariableDeclaration } from '../types.js';

interface InkStoryGraph {
  id: string;
  title: string;
  nodes: Record<
    string,
    {
      id: string;
      type: 'knot' | 'stitch' | 'gather';
      content: ContentBlock[];
      choices: { text: string; target: string; condition?: Expression | null }[];
      divert: string | null;
      tags: string[];
      /** See shared/src/types.ts's `StoryNode.params` (DEV-199 Phase
       * 10b / function-knots). */
      params?: string[];
    }
  >;
  startNode: string;
  variables?: VariableDeclaration[];
}

/**
 * `emitInk` — the round-trip counterpart to
 * `emitTwee` in twee-emitter.ts. Alias for the existing
 * `convertStoryGraphToInk` so both format emitters have symmetric
 * naming. Kept the original name as an export too for backwards
 * compatibility with anything that imported it before.
 */
export function emitInk(storyGraph: InkStoryGraph): string {
  return convertStoryGraphToInk(storyGraph);
}

export function convertStoryGraphToInk(storyGraph: InkStoryGraph): string {
  const lines: string[] = [];
  const nodes = storyGraph.nodes;
  const processedNodes = new Set<string>();

  // VAR/CONST/LIST preamble (DEV-199 Phase 1 / Phase 10), in
  // declaration order. Must come before any knot content, matching
  // Ink's own convention and what the parser expects on re-import.
  for (const decl of storyGraph.variables ?? []) {
    // A genuine `LIST name = ...` declaration's own value always has
    // origin === its own name (parseListDeclarationLine sets this up
    // that way). A plain VAR/CONST that merely evaluates to a list
    // value — e.g. `VAR temp = cold` (a bare reference to another
    // LIST's member) or `CONST allStates = LIST_ALL(kettleState)` —
    // is type:'list' too, but its value's origin points at the OTHER
    // list it came from, not at itself, and must round-trip as an
    // ordinary VAR/CONST (falling through below), not be re-emitted
    // as a second, bogus `LIST` declaration with no members of its
    // own.
    const isGenuineListDeclaration =
      decl.type === 'list' &&
      decl.initialValue.kind === 'literal' &&
      isListValue(decl.initialValue.value) &&
      decl.initialValue.value.origin === decl.name;
    if (isGenuineListDeclaration) {
      // A LIST declares its FULL member set, with parens marking
      // which ones start active — this is NOT `printExpression` of
      // the initial value, which only carries the active subset, not
      // every member the LIST defines.
      const activeNames = new Set(
        decl.initialValue.kind === 'literal' && isListValue(decl.initialValue.value)
          ? decl.initialValue.value.items.map((item) => item.name)
          : [],
      );
      const members = (decl.listMembers ?? []).map((name) =>
        activeNames.has(name) ? `(${name})` : name,
      );
      lines.push(`LIST ${decl.name} = ${members.join(', ')}`);
      continue;
    }
    const keyword = decl.isConst ? 'CONST' : 'VAR';
    lines.push(`${keyword} ${decl.name} = ${printExpression(decl.initialValue)}`);
  }

  // sanitize a StoryNode id into a legal Ink knot / stitch
  // identifier. Ink allows only `[A-Za-z_][A-Za-z0-9_]*`, but Twee
  // 3 (and future Ink extensions) allow arbitrary characters
  // including whitespace and hyphens. Replace runs of illegal
  // characters with `_` and strip leading digits so the emitted
  // `.ink` file re-parses. Collisions between two sanitised names
  // are broken by suffixing a stable index — we build the id map
  // once and reuse it everywhere target/reference names appear.
  const sanitize = (name: string): string => {
    let out = name.replace(/[^A-Za-z0-9_]+/g, '_');
    if (/^[0-9]/.test(out)) out = '_' + out;
    if (!out) out = '_';
    return out;
  };
  const idMap: Record<string, string> = {};
  {
    const used = new Set<string>();
    for (const nodeId of Object.keys(nodes)) {
      let candidate = sanitize(nodeId);
      let suffix = 1;
      const base = candidate;
      while (used.has(candidate)) {
        suffix++;
        candidate = `${base}_${suffix}`;
      }
      used.add(candidate);
      idMap[nodeId] = candidate;
    }
  }
  const inkId = (nodeId: string): string => idMap[nodeId] ?? sanitize(nodeId);

  // Helper to get the parent knot of a stitch
  const getParentKnot = (stitchId: string): string | null => {
    if (!stitchId.includes('.')) return null;
    return stitchId.split('.')[0];
  };

  // Helper to format a node reference for Ink. Sanitises via inkId
  // so a Twee-imported graph with names like `The Kitchen` reaches
  // Ink as `The_Kitchen`. The short-form path (stitch in the same
  // knot) resolves against the full nodeId and then strips the
  // sanitised knot prefix — that way any collisions our idMap
  // resolved are preserved on both sides of the reference.
  const formatTarget = (target: string, currentKnot: string | null): string => {
    if (target === 'END' || target === 'DONE') return target;
    const sanitisedTarget = inkId(target);
    if (currentKnot && target.startsWith(currentKnot + '.')) {
      const sanitisedKnot = inkId(currentKnot);
      if (sanitisedTarget.startsWith(sanitisedKnot + '_')) {
        return sanitisedTarget.slice(sanitisedKnot.length + 1);
      }
    }
    return sanitisedTarget;
  };

  // Process a single node
  const processNode = (nodeId: string, currentKnot: string | null) => {
    if (processedNodes.has(nodeId)) return;
    processedNodes.add(nodeId);

    const node = nodes[nodeId];
    if (!node) return;

    // Write node header. Sanitise both the knot and the stitch
    // suffix so `:: The Kitchen` from Twee lands as
    // `=== The_Kitchen ===` in Ink instead of an unparseable
    // `=== The Kitchen ===`.
    if (node.type === 'knot') {
      lines.push('');
      // Function-knots (DEV-199 Phase 10b): re-emit the `function`
      // keyword and parameter list so a round-trip through
      // parseInk stays a function-knot, not a plain one that
      // happens to share its name — see ink-parser.ts's parseKnot,
      // which is what sets `internal:function` + `params` in the
      // first place.
      if (node.tags.includes('internal:function')) {
        lines.push(`=== function ${inkId(node.id)}(${(node.params ?? []).join(', ')}) ===`);
      } else {
        lines.push(`=== ${inkId(node.id)} ===`);
      }
    } else if (node.type === 'stitch') {
      const sanitisedFull = inkId(node.id);
      const parent = getParentKnot(node.id);
      let stitchName: string;
      if (parent) {
        const sanitisedParent = inkId(parent);
        stitchName = sanitisedFull.startsWith(sanitisedParent + '_')
          ? sanitisedFull.slice(sanitisedParent.length + 1)
          : sanitisedFull;
      } else {
        stitchName = sanitisedFull;
      }
      lines.push('');
      lines.push(`= ${stitchName}`);
    }

    // Write node-level tags. `internal:function` is skipped — it's
    // bookkeeping ink-parser.ts's own `isFunction` flag re-derives
    // from the `function` keyword re-emitted on the header line
    // above, not an author-visible tag; re-emitting it as `# ...`
    // would have it come back as a SECOND, duplicate tag on the next
    // parse (the header line already re-adds it), growing by one
    // every round-trip.
    for (const tag of node.tags) {
      if (tag === 'internal:function') continue;
      lines.push(`# ${tag}`);
    }

    // Write content
    for (const content of node.content) {
      // In-content assignment (DEV-199 Phase 1) — re-emit as `~ stmt`.
      // `condition` (DEV-199 follow-up) only arises from a Twine-
      // dialect-authored graph (a SugarCube/Chapbook `<<set>>`/`name
      // (COND): value` nested inside a conditional) being exported TO
      // Ink — Ink's own `~` syntax never produces one. Real Ink's
      // `{condition: ...}` weave block can wrap arbitrary content,
      // including `~` statements, when written multi-line — this
      // backend's own ink-parser.ts only understands the single-line
      // `{cond: text}` TEXT form (see its CONDITIONAL_TEXT_RE), so a
      // story re-uploaded here after this round-trip would come back
      // with the condition dropped — a pre-existing gap in this
      // parser's conditional-block support, not something this
      // function can fix on its own. Emitting it this way is still
      // strictly better than silently making the assignment
      // unconditional (which would be actively wrong) or omitting it
      // outright: a real Ink engine, or a future multi-line-aware
      // version of this parser, reads it correctly.
      if (content.kind === 'assignment') {
        const stmt = `~ ${printStatement(content.statement)}`;
        lines.push(
          content.condition ? `{ ${printExpression(content.condition)}:\n    ${stmt}\n}` : stmt,
        );
        continue;
      }
      // Conditional text (DEV-199 Phase 3) — wrap in `{condition: text}`
      // before tags, matching the shape the parser expects on re-import.
      let line = content.condition
        ? `{${printExpression(content.condition)}: ${content.text}}`
        : content.text;
      if (content.tags.length > 0) {
        line += ' ' + content.tags.map((t) => `# ${t}`).join(' ');
      }
      lines.push(line);
    }

    // Write choices
    for (const choice of node.choices) {
      const target = formatTarget(choice.target, currentKnot);
      // Conditional choice visibility (DEV-199 Phase 4) — re-emit as
      // a `{condition}` prefix, matching what the parser expects.
      const conditionPrefix = choice.condition ? `{${printExpression(choice.condition)}} ` : '';
      lines.push(`* ${conditionPrefix}[${choice.text}] -> ${target}`);
    }

    // Write divert (if no choices)
    if (node.choices.length === 0 && node.divert) {
      const target = formatTarget(node.divert, currentKnot);
      lines.push(`-> ${target}`);
    }
  };

  // Group nodes by knot
  const knots: Record<string, string[]> = {};
  const topLevelKnots: string[] = [];

  for (const nodeId of Object.keys(nodes)) {
    const node = nodes[nodeId];
    if (node.type === 'knot') {
      topLevelKnots.push(nodeId);
      knots[nodeId] = [];
    } else if (node.type === 'stitch') {
      const parent = getParentKnot(nodeId);
      if (parent) {
        if (!knots[parent]) knots[parent] = [];
        knots[parent].push(nodeId);
      }
    }
  }

  // Sort knots, putting start node first
  topLevelKnots.sort((a, b) => {
    if (a === storyGraph.startNode) return -1;
    if (b === storyGraph.startNode) return 1;
    return a.localeCompare(b);
  });

  // Process knots and their stitches
  for (const knotId of topLevelKnots) {
    processNode(knotId, knotId);

    // Process stitches within this knot
    const stitches = knots[knotId] || [];
    stitches.sort((a, b) => a.localeCompare(b));
    for (const stitchId of stitches) {
      processNode(stitchId, knotId);
    }
  }

  // Process any remaining nodes (gathers, etc.)
  for (const nodeId of Object.keys(nodes)) {
    if (!processedNodes.has(nodeId)) {
      processNode(nodeId, null);
    }
  }

  return lines.join('\n');
}
