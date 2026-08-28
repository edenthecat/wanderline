// How a reference to a passage becomes a passage.
//
// Its own module rather than a corner of App.tsx because three things
// have to agree about where a story goes next — playback, the preload
// walk, and the offline download ordering (see fall-through.ts, which
// makes the same point about implicit continuation). Two of them live
// outside the component, and importing them back out of App.tsx would
// be a cycle.

/** Own-property check, so a node id that collides with something on
 * Object.prototype ("constructor", "toString") can't resolve to a
 * passage the story doesn't have. */
export function hasNode(nodes: Record<string, unknown>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(nodes, id);
}

/** END / DONE are the parser's terminals, not passages. */
export const TERMINAL_TARGETS = new Set(['END', 'DONE']);

/**
 * Resolve a story reference — a choice target, a divert, or the
 * `?start=` parameter — to a real node id, or null if nothing matches.
 *
 * Three steps, in order:
 *
 *  1. An exact node id.
 *  2. The reference qualified by `contextNodeId`'s knot. Stories
 *     imported from compiled .ink.json routinely carry bare stitch
 *     names on choices, because the source author wrote a relative
 *     divert (`-> .infinite_grace`) and the compiler kept the short
 *     form. From inside "tell_you", "infinite_grace" means
 *     "tell_you.infinite_grace".
 *  3. Any node ending in `.reference`. Picks the first match — a
 *     well-formed story has only one, and if it doesn't, the project's
 *     graph has a real bug worth flagging in the editor; the player
 *     would still rather proceed than hang.
 *
 * Shared by in-story navigation (context: the passage the listener is
 * on) and the `?start=` deep link (context: the story's start node, the
 * only knot there is before anyone has moved). One resolver so a link
 * an author can write in the editor cannot resolve differently from the
 * same reference followed mid-story.
 */
export function resolveNodeReference(
  reference: string,
  nodes: Record<string, unknown>,
  contextNodeId: string | null | undefined,
): string | null {
  if (hasNode(nodes, reference)) return reference;
  const knot = contextNodeId?.split('.')[0];
  if (knot) {
    const qualified = `${knot}.${reference}`;
    if (hasNode(nodes, qualified)) return qualified;
  }
  const suffix = `.${reference}`;
  for (const id of Object.keys(nodes)) {
    if (id.endsWith(suffix)) return id;
  }
  return null;
}

/**
 * Where a reference actually leads when walking the graph: the resolved
 * node id, or null for "nowhere to go" — a terminal, an empty
 * reference, or one nothing in the story matches.
 *
 * The walks (preload, offline download order) used to index `nodes`
 * directly and drop whatever missed, so a bare stitch name stopped the
 * walk dead and the passages about to play were the ones NOT prepared.
 */
export function stepTo(
  reference: string | null | undefined,
  nodes: Record<string, unknown>,
  fromNodeId: string,
): string | null {
  if (!reference || TERMINAL_TARGETS.has(reference)) return null;
  return resolveNodeReference(reference, nodes, fromNodeId);
}
