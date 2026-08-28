/**
 * Where a passage falls through to when it names nowhere.
 *
 * Ink runs a knot by running its first stitch, and a stitch that ends
 * without a divert continues into the next sibling. Neither parser
 * materialises that as a divert — `storyHealth` compensates the same
 * way for reachability — so without this the player reads "no choices,
 * no divert" as the end of the story and prints The End in the middle
 * of a chapter.
 *
 * Shared rather than reimplemented per caller: playback, the offline
 * download ordering and the preload walk all have to agree on where a
 * passage goes, and two copies of this drift.
 *
 * `nodeId` is passed rather than read off `node` because the callers
 * type their node maps differently and the id is always in hand at the
 * call site. Returns null when the passage really is a terminus.
 */
export function fallThroughTarget(
  nodeId: string,
  node:
    | {
        type?: string;
        parent?: string | null;
        choices?: { target?: string }[];
        divert?: string | null;
      }
    | null
    | undefined,
  nodes: Record<string, { type?: string; parent?: string | null; lineNumber?: number }>,
): string | null {
  if (!node || node.divert || (node.choices?.length ?? 0) > 0) return null;
  const candidates: Array<{ id: string; lineNumber: number }> = [];
  if (node.type === 'knot') {
    for (const [id, n] of Object.entries(nodes)) {
      if (n.parent === nodeId && n.type === 'stitch') {
        candidates.push({ id, lineNumber: n.lineNumber ?? 0 });
      }
    }
    candidates.sort((a, b) => a.lineNumber - b.lineNumber);
    return candidates[0]?.id ?? null;
  }
  if (node.type === 'stitch' && node.parent) {
    for (const [id, n] of Object.entries(nodes)) {
      if (n.parent === node.parent && n.type === 'stitch') {
        candidates.push({ id, lineNumber: n.lineNumber ?? 0 });
      }
    }
    candidates.sort((a, b) => a.lineNumber - b.lineNumber);
    const i = candidates.findIndex((c) => c.id === nodeId);
    return i >= 0 ? (candidates[i + 1]?.id ?? null) : null;
  }
  return null;
}
