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
// Ink only. Twee has no equivalent scoping rule: twee-parser uses the
// passage name verbatim as the node id and never sets `parent`, and a
// period is a legal character, so `Section.Scene` naming is ordinary.
// Applying knot-scoping there would read a broken `[[Key]]` inside
// `Hall.Door` as `Hall.Key` and silently repoint it at a real passage —
// hiding exactly the broken link the parser reports as an error.
//
// The stored graph is not rewritten; edits PATCH individual fields, so
// nothing here is persisted as a side effect.

import type { StoryGraph } from '../api/client';
import { computeStoryHealth } from './storyHealth';

const TERMINAL_TARGETS = new Set(['END', 'DONE']);

/**
 * Resolve `target` as written on `fromNodeId` to a real node id, or
 * return it untouched when it names nothing — a genuinely broken link,
 * which the editor still needs to surface as "(missing)".
 *
 * Two tiers, deliberately: an exact id, then the referring node's own
 * knot. No suffix fallback — the parser (`resolveBareStitchTargets`)
 * and the build's own gate (`build-service`'s `resolveTarget`) both
 * stop at two, and a third tier here would let the editor draw a solid
 * edge across knots for a story the build then rejects. The player is
 * more lenient at runtime, but that is a don't-strand-the-listener
 * choice, not the authoring contract.
 */
function resolveTarget(target: string, fromNodeId: string, nodeIds: ReadonlySet<string>): string {
  if (!target || TERMINAL_TARGETS.has(target) || nodeIds.has(target)) return target;
  const knot = fromNodeId.split('.')[0];
  const qualified = `${knot}.${target}`;
  return nodeIds.has(qualified) ? qualified : target;
}

/**
 * Return a graph whose choice and divert targets all name real nodes
 * where they can. Returns the input unchanged when there is nothing to
 * qualify, so a post-fix graph costs one pass and no allocation.
 */
export function normalizeStoryGraph<T extends StoryGraph | null | undefined>(
  graph: T,
  sourceLanguage?: 'ink' | 'twee' | null,
): T {
  if (!graph?.nodes || sourceLanguage === 'twee') return graph;
  const nodeIds = new Set(Object.keys(graph.nodes));
  let changed = false;
  // Null-prototype: `__proto__` is a legal passage name and a legal
  // knot name, and assigning it on a plain object literal hits the
  // prototype setter and creates no own property — silently dropping
  // that node from every consumer that walks Object.keys.
  const nodes: Record<string, unknown> = Object.create(null);
  for (const [id, node] of Object.entries(graph.nodes)) {
    // Tracked per node: `choices.map` always returns a fresh array, so
    // comparing array identity would rebuild every node on every load
    // and quietly add `choices: []` / `divert: undefined` keys to nodes
    // that never had them.
    let nodeChanged = false;
    const choices = node.choices?.map((c) => {
      const target = resolveTarget(c.target, id, nodeIds);
      if (target === c.target) return c;
      nodeChanged = true;
      return { ...c, target };
    });
    const divert = node.divert ? resolveTarget(node.divert, id, nodeIds) : node.divert;
    if (divert !== node.divert) nodeChanged = true;
    if (nodeChanged) {
      changed = true;
      nodes[id] = { ...node, ...(choices ? { choices } : {}), divert };
    } else {
      nodes[id] = node;
    }
  }
  if (!changed) return graph;
  const normalized = { ...graph, nodes } as T & StoryGraph;

  // The stored validation blob was computed against the un-qualified
  // targets and nothing re-validates on read, so a legacy project
  // carries `unreachable_node` warnings for knots that are reachable
  // once the targets resolve. Left alone, the Graph tab would paint a
  // warning badge and the ValidationPanel would list a node that the
  // health panel — reading the same graph — now calls reachable.
  const warnings = normalized.validation?.warnings;
  if (!warnings?.some((w) => w.type === 'unreachable_node')) return normalized;
  const { reachableNodes } = computeStoryHealth(normalized);
  const kept = warnings.filter(
    (w) => !(w.type === 'unreachable_node' && w.nodeId && reachableNodes.has(w.nodeId)),
  );
  if (kept.length === warnings.length) return normalized;
  return {
    ...normalized,
    validation: { ...normalized.validation, warnings: kept },
  } as T & StoryGraph;
}
