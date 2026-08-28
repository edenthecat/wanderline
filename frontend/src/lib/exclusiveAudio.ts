// One sound at a time, across the whole editor.
//
// useAudition enforces that within a single hook instance — one Audio
// element, one now-playing id. That was enough while every view owned
// exactly one instance, but the node panel does not: StoryTab mounts a
// NodeDetail per listed passage, and expanding two of them gives you
// two independent players. Auditioning a clip in one while a passage
// mix runs in the other layers unrelated audio on top of each other,
// which is precisely the judgement ("does this voiceover survive the
// bed under it?") the in-context control exists to support.
//
// So the exclusivity lives above the hooks: whoever starts sounding
// claims the floor, and claiming it stops whoever held it. A module
// global rather than a context because it isn't render state — nothing
// re-renders when the holder changes, and a provider would have to be
// threaded through every view that plays anything.

let holder: (() => void) | null = null;

/**
 * Take the floor, stopping whatever held it. Pass a STABLE stop
 * function (a useCallback with no changing deps): identity is what
 * tells a re-claim by the same player apart from a takeover, and what
 * lets `releaseAudio` know it is still the holder.
 */
export function claimAudio(stop: () => void): void {
  const previous = holder;
  // Record the claim before handing control to the outgoing player.
  // Its stop() calls releaseAudio() on the way out, and that release
  // is identity-checked — it is no longer the holder, so it cannot
  // clear the claim just made.
  holder = stop;
  if (previous && previous !== stop) previous();
}

/** Give the floor up, if this player still holds it. */
export function releaseAudio(stop: () => void): void {
  if (holder === stop) holder = null;
}
