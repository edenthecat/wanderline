// Resolving a divert/choice target to a node id.
//
// Ink scopes a bare name inside a knot to that knot's own stitches, so
// `-> read_email_5` written in `== inbox ==` names `inbox.read_email_5`.
// The parser now qualifies these at parse time, but story graphs are
// persisted: every project uploaded before that fix still has bare
// targets stored, and nothing re-parses them on read. So the editor has
// to resolve them too, or those projects keep showing phantom broken
// links until someone re-uploads the .ink.
//
// The order matches the backend's validateGraph and the player's
// navigateToTarget, which have both always been tolerant this way —
// exact id, then the current knot's stitch, then any node with a
// matching suffix. The editor was the only place that wasn't.

const TERMINAL_TARGETS = new Set(['END', 'DONE']);

export function isTerminalTarget(target: string | null | undefined): boolean {
  return !!target && TERMINAL_TARGETS.has(target);
}

/**
 * Resolve `target` as written on `fromNodeId` to a real node id.
 *
 * Returns null when the target names no node — a genuinely broken link,
 * which callers surface as "(missing)". Terminal targets (END/DONE)
 * also return null; they are sinks, not nodes, and every caller here
 * handles them before asking.
 */
export function resolveTarget(
  target: string | null | undefined,
  fromNodeId: string,
  nodeIds: ReadonlySet<string>,
): string | null {
  if (!target || isTerminalTarget(target)) return null;
  if (nodeIds.has(target)) return target;
  const knot = fromNodeId.split('.')[0];
  const qualified = `${knot}.${target}`;
  if (nodeIds.has(qualified)) return qualified;
  // Last resort: any node ending `.target`. Ambiguous in principle, but
  // a well-formed story has exactly one, and resolving to the wrong
  // stitch is still better than reporting a working story as broken.
  const suffix = `.${target}`;
  for (const id of nodeIds) {
    if (id.endsWith(suffix)) return id;
  }
  return null;
}
