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
// Two normalizations happen here, with different scopes.
//
// Target qualification is Ink only. Twee has no equivalent scoping
// rule: twee-parser uses the passage name verbatim as the node id and
// never sets `parent`, and a
// period is a legal character, so `Section.Scene` naming is ordinary.
// Applying knot-scoping there would read a broken `[[Key]]` inside
// `Hall.Door` as `Hall.Key` and silently repoint it at a real passage —
// hiding exactly the broken link the parser reports as an error.
//
// Node identity is repaired for BOTH languages. A stored graph is a
// record keyed by node id whose values ALSO carry an `id` field, and
// nothing has ever guaranteed the two agree — the backend's rename
// cascade only rewrites a stitch's own `id` when it already matched
// its key. Consumers then split: the graph tab, the ⌘K palette and
// every `nodes[id]` lookup key off the record key, while the story
// list renders `data-node-id={node.id}` and expands by it. A graph
// where they diverge shows a passage in one tab that can't be found
// from the other. The record key wins — it is the one every lookup
// uses — and settling that here means no consumer has to know.
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
 * where they can, and whose every node carries the id it is filed
 * under. Returns the input unchanged when there is nothing to fix, so
 * a post-fix graph costs one pass and no allocation.
 */
export function normalizeStoryGraph<T extends StoryGraph | null | undefined>(
  graph: T,
  sourceLanguage?: 'ink' | 'twee' | null,
): T {
  if (!graph?.nodes) return graph;
  const qualifyTargets = sourceLanguage !== 'twee';
  const nodeIds = new Set(Object.keys(graph.nodes));
  let changed = false;
  // Null-prototype: `__proto__` is a legal passage name and a legal
  // knot name, and assigning it on a plain object literal hits the
  // prototype setter and creates no own property — silently dropping
  // that node from every consumer that walks Object.keys.
  const nodes: Record<string, unknown> = Object.create(null);
  for (const [id, node] of Object.entries(graph.nodes)) {
    // Tracked per node: `choices.map` always returns a fresh array, so
    // comparing array identity would rebuild every node on every load,
    // and each rebuild would add `choices` / `divert` keys to nodes
    // that never had them.
    if (!node) {
      // Every other consumer tolerates a null node in a stored graph.
      // This runs inside fetchProject, so throwing here would turn one
      // oddly-rendered tab into a project page that won't open at all.
      nodes[id] = node;
      continue;
    }
    let nodeChanged = false;
    const choices = qualifyTargets
      ? node.choices?.map((c) => {
          const target = resolveTarget(c.target, id, nodeIds);
          if (target === c.target) return c;
          nodeChanged = true;
          return { ...c, target };
        })
      : undefined;
    const divert =
      qualifyTargets && node.divert ? resolveTarget(node.divert, id, nodeIds) : node.divert;
    if (divert !== node.divert) nodeChanged = true;
    const idMismatch = node.id !== id;
    if (idMismatch) nodeChanged = true;
    if (nodeChanged) {
      changed = true;
      const next: Record<string, unknown> = { ...node };
      if (choices) next.choices = choices;
      if (divert !== node.divert) next.divert = divert;
      if (idMismatch) next.id = id;
      nodes[id] = next;
    } else {
      nodes[id] = node;
    }
  }
  if (!changed) return graph;
  // `validation` is left exactly as stored. It is tempting to strip
  // `unreachable_node` warnings that qualification makes obsolete, but
  // there are none: the backend's findReachableNodes already suffix-
  // matches bare targets, and it never warns about a dotted id at all.
  // Filtering them against computeStoryHealth would also delete true
  // warnings, because its Ink fall-through synthesis reaches knots that
  // real Ink never enters.
  return { ...graph, nodes } as T;
}
