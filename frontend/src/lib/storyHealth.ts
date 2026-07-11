// Author QoL: derive a few "is this story actually playable" facts
// from a parsed story_graph.
//
// Pure, no React, easy to unit-test. Used by StoryHealthPanel to
// surface unreachable nodes, dead-ends, and a rough playtime
// estimate in the Story tab.
//
// Definitions:
//   - reachable: BFS from startNode, following each node's `choices[*].target`
//     and `divert`. Synthetic targets `END` and `DONE` are sinks.
//   - unreachable: every node NOT in `reachable`. The author probably
//     wrote it and then orphaned it.
//   - deadEnd: a reachable node with NO outgoing edges (no non-sink
//     divert, no choices) that ISN'T explicitly tagged as an
//     ending. These trap the listener mid-story.
//   - words: total word count across every reachable node's content.
//     Coarse reading-time estimate at 160 wpm (typical narrator pace).

import type { StoryGraph, StoryNode } from '../api/client';

const SINK_TARGETS = new Set(['END', 'DONE', '']);

/** Average narrator words-per-minute. Tweakable single source of
 * truth for the playtime estimate. */
export const NARRATOR_WPM = 160;

export interface StoryHealthReport {
  totalNodes: number;
  reachableNodes: Set<string>;
  unreachableNodes: string[];
  deadEndNodes: string[];
  /** Total words across all reachable content lines. */
  totalWords: number;
  /** Rough minutes to read aloud at NARRATOR_WPM. */
  estimatedMinutes: number;
}

function isSink(target: string | null | undefined): boolean {
  return !target || SINK_TARGETS.has(target);
}

function outgoingTargets(node: StoryNode, graph: StoryGraph): string[] {
  const out: string[] = [];
  for (const c of node.choices ?? []) {
    if (!isSink(c.target)) out.push(c.target);
  }
  if (!isSink(node.divert)) out.push(node.divert as string);
  // Ink fall-through: a knot with no explicit divert + no choices
  // falls into its first stitch (by line order). A stitch with no
  // explicit divert + no choices falls into the next sibling stitch
  // under the same parent. The parser doesn't materialize these as
  // diverts, so we have to walk the parent/lineNumber relationship
  // here or every multi-stitch knot looks "unreachable".
  if (out.length === 0) {
    if (node.type === 'knot') {
      const firstStitch = Object.values(graph.nodes)
        .filter((n) => n.parent === node.id && n.type === 'stitch')
        .sort((a, b) => a.lineNumber - b.lineNumber)[0];
      if (firstStitch) out.push(firstStitch.id);
    } else if (node.type === 'stitch' && node.parent) {
      const siblings = Object.values(graph.nodes)
        .filter((n) => n.parent === node.parent && n.type === 'stitch')
        .sort((a, b) => a.lineNumber - b.lineNumber);
      const idx = siblings.findIndex((s) => s.id === node.id);
      const next = idx >= 0 ? siblings[idx + 1] : undefined;
      if (next) out.push(next.id);
    }
  }
  return out;
}

function countWords(s: string | undefined | null): number {
  if (!s) return 0;
  // Split on whitespace + filter out empty strings.
  return s
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function hasOutgoing(node: StoryNode, graph: StoryGraph): boolean {
  // A node with ANY choice — even one whose target is END/DONE —
  // offers the reader a way to progress. Only nodes with neither
  // choices, an explicit divert, nor a knot/stitch fall-through
  // can actually trap the listener. `outgoingTargets` strips sinks
  // for BFS purposes, so we check the raw choices array first before
  // falling back to it.
  if ((node.choices ?? []).length > 0) return true;
  return outgoingTargets(node, graph).length > 0;
}

function isExplicitEnding(node: StoryNode): boolean {
  if (!node.tags) return false;
  // Tag casing is author-driven; treat #Ending / #END / #ending all
  // as the same explicit-ending marker so spelling variants don't
  // produce spurious dead-ends.
  return node.tags.some((t) => t.toLowerCase() === 'ending');
}

export function computeStoryHealth(graph: StoryGraph | null | undefined): StoryHealthReport {
  if (!graph) {
    return {
      totalNodes: 0,
      reachableNodes: new Set(),
      unreachableNodes: [],
      deadEndNodes: [],
      totalWords: 0,
      estimatedMinutes: 0,
    };
  }
  const allIds = Object.keys(graph.nodes ?? {});
  const reachable = new Set<string>();
  const queue: string[] = [];
  if (graph.startNode && graph.nodes[graph.startNode]) {
    queue.push(graph.startNode);
    reachable.add(graph.startNode);
  }
  // Index-pointer instead of Array.shift(); shift() is O(n) per
  // call (array re-index), which would make this BFS O(n^2) on
  // larger stories. With an index we get amortized O(n) total.
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const node = graph.nodes[id];
    if (!node) continue;
    for (const target of outgoingTargets(node, graph)) {
      if (!graph.nodes[target]) continue; // dangling target — counted as a validation error elsewhere
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }

  const unreachable = allIds.filter((id) => !reachable.has(id)).sort();
  const deadEnds: string[] = [];
  let totalWords = 0;
  for (const id of reachable) {
    const node = graph.nodes[id];
    if (!node) continue;
    for (const item of node.content ?? []) totalWords += countWords(item.text);
    if (!hasOutgoing(node, graph) && !isExplicitEnding(node)) deadEnds.push(id);
  }
  deadEnds.sort();
  const estimatedMinutes = totalWords > 0 ? Math.max(1, Math.round(totalWords / NARRATOR_WPM)) : 0;
  return {
    totalNodes: allIds.length,
    reachableNodes: reachable,
    unreachableNodes: unreachable,
    deadEndNodes: deadEnds,
    totalWords,
    estimatedMinutes,
  };
}
