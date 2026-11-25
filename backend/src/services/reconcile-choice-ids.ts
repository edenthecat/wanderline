/**
 * Carries a choice's stable id forward across a FULL source
 * re-upload (POST /ink, /ink-json, /twine) instead of letting it get
 * a fresh randomUUID() every time.
 *
 * ink-parser.ts / twee-parser.ts mint a brand-new id for every choice
 * on every parse — stable across in-place edits (REST PATCHes, Yjs
 * collab), but NOT across a full re-upload, since the parser has no
 * memory of the previous graph. Per-choice audio is addressed by
 * that id (`choice:<id>` in node_audio_assignments), so without this
 * reconciliation step, re-uploading byte-identical (or lightly
 * edited) source silently drops every per-choice cue — the id each
 * assignment row references no longer exists anywhere in the new
 * graph, and nothing ever cleans up the now-orphaned row either.
 *
 * Deliberately scoped to CHOICES only, not content blocks: nothing in
 * this codebase addresses a content block by id yet (per-choice audio
 * is the only id-addressed audio feature shipped so far), so there's
 * nothing real to reconcile there. If per-block audio ever ships,
 * the same approach — reconcileByNode with a content-specific match
 * key — would extend to it.
 */

import type { Choice, StoryGraph } from '../types.js';

/**
 * Mutates `newGraph` in place: for every node that exists under the
 * SAME id in both graphs, each of that node's new choices is matched
 * against an unmatched old choice and, if found, takes over the old
 * choice's id. A renamed/removed/added node has nothing to reconcile
 * against and is left exactly as the parser produced it.
 *
 * Matching within a node tries progressively weaker signals, each
 * old choice consumed by at most one match:
 *   1. exact (target, text) — the common case: nothing about this
 *      choice changed.
 *   2. same target only — the author edited the choice's wording but
 *      it still goes to the same place, so it's still "the same"
 *      choice for audio-addressing purposes.
 *   3. same ordinal position among whatever's left unmatched after
 *      1 and 2 — the last resort for e.g. a choice whose target AND
 *      text both changed, which otherwise can't be told apart from a
 *      brand-new choice at all.
 *
 * `oldGraph` undefined (first-ever upload for this project) is a
 * no-op — there's nothing to reconcile against.
 */
export function reconcileChoiceIds(oldGraph: StoryGraph | undefined, newGraph: StoryGraph): void {
  if (!oldGraph) return;
  for (const nodeId of Object.keys(newGraph.nodes)) {
    if (!Object.hasOwn(oldGraph.nodes, nodeId)) continue;
    reconcileNodeChoices(oldGraph.nodes[nodeId].choices, newGraph.nodes[nodeId].choices);
  }
}

function reconcileNodeChoices(oldChoices: Choice[], newChoices: Choice[]): void {
  const usedOld = new Set<number>();
  const matchedNew = new Set<number>();

  const findOldIndex = (predicate: (o: Choice) => boolean): number => {
    for (let i = 0; i < oldChoices.length; i++) {
      if (usedOld.has(i) || !oldChoices[i].id) continue;
      if (predicate(oldChoices[i])) return i;
    }
    return -1;
  };

  // Pass 1: exact (target, text) match.
  newChoices.forEach((choice, newIdx) => {
    if (matchedNew.has(newIdx)) return;
    const oldIdx = findOldIndex((o) => o.target === choice.target && o.text === choice.text);
    if (oldIdx === -1) return;
    choice.id = oldChoices[oldIdx].id;
    usedOld.add(oldIdx);
    matchedNew.add(newIdx);
  });

  // Pass 2: same target only (text edited).
  newChoices.forEach((choice, newIdx) => {
    if (matchedNew.has(newIdx)) return;
    const oldIdx = findOldIndex((o) => o.target === choice.target);
    if (oldIdx === -1) return;
    choice.id = oldChoices[oldIdx].id;
    usedOld.add(oldIdx);
    matchedNew.add(newIdx);
  });

  // Pass 3: positional, among whatever's left on both sides.
  const remainingOld = oldChoices
    .map((_, i) => i)
    .filter((i) => !usedOld.has(i) && oldChoices[i].id);
  const remainingNew = newChoices.map((_, i) => i).filter((i) => !matchedNew.has(i));
  for (let k = 0; k < Math.min(remainingOld.length, remainingNew.length); k++) {
    newChoices[remainingNew[k]].id = oldChoices[remainingOld[k]].id;
  }
}
