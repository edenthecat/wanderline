// Qualifying bare stitch targets on a story graph as it enters the editor.
//
// Ink scopes a bare name inside a knot to that knot's own stitches, so
// `-> read_email_5` written in `== inbox ==` names `inbox.read_email_5`.
// The parser now qualifies these at upload time, but story graphs are
// persisted and nothing re-parses them on read: every project uploaded
// before that fix still has bare targets stored.
//
// This runs once, where the graph enters the app, rather than asking
// each consumer to be tolerant. That matters because the consumers do
// not agree on what "tolerant" means — the choice/divert dropdowns key
// on exact node ids to pick a <select> option, the graph tab draws a
// "missing" node for anything not in `nodes`, `reverseEdges` keys the
// "Reachable from" list by raw target, and story health walks by exact
// id. Making some of them resolve and not others produced the same
// graph reporting different answers in different tabs. Normalizing at
// the boundary keeps them consistent by construction.
//
// The stored graph is not rewritten; edits PATCH individual fields, so
// nothing here is persisted as a side effect.

import type { StoryGraph } from '../api/client';

const TERMINAL_TARGETS = new Set(['END', 'DONE']);

/**
 * Resolve `target` as written on `fromNodeId` to a real node id, or
 * return it untouched when it names nothing — a genuinely broken link,
 * which the editor still needs to surface as "(missing)".
 *
 * The order matches the backend's `validateGraph` and the player's
 * `navigateToTarget`: exact id, then the current knot's stitch, then
 * any node with a matching suffix.
 */
function resolveTarget(target: string, fromNodeId: string, nodeIds: ReadonlySet<string>): string {
  if (!target || TERMINAL_TARGETS.has(target) || nodeIds.has(target)) return target;
  const knot = fromNodeId.split('.')[0];
  const qualified = `${knot}.${target}`;
  if (nodeIds.has(qualified)) return qualified;
  // Last resort: any node ending `.target`. Ambiguous in principle, but
  // a well-formed story has exactly one, and resolving to the wrong
  // stitch still beats reporting a working story as broken.
  const suffix = `.${target}`;
  for (const id of nodeIds) {
    if (id.endsWith(suffix)) return id;
  }
  return target;
}

/**
 * Return a graph whose choice and divert targets all name real nodes
 * where they can. Returns the input unchanged when there is nothing to
 * qualify, so a post-fix graph costs one pass and no allocation.
 */
export function normalizeStoryGraph<T extends StoryGraph | null | undefined>(graph: T): T {
  if (!graph?.nodes) return graph;
  const nodeIds = new Set(Object.keys(graph.nodes));
  let changed = false;
  const nodes: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    let next = node;
    const choices = node.choices ?? [];
    const newChoices = choices.map((c) => {
      const target = resolveTarget(c.target, id, nodeIds);
      if (target === c.target) return c;
      changed = true;
      return { ...c, target };
    });
    const divert = node.divert ? resolveTarget(node.divert, id, nodeIds) : node.divert;
    if (divert !== node.divert) changed = true;
    if (newChoices !== choices || divert !== node.divert) {
      next = { ...node, choices: newChoices, divert };
    }
    nodes[id] = next;
  }
  if (!changed) return graph;
  return { ...graph, nodes } as T;
}
