// Scroll an element into view that may not be mounted yet.
//
// Both callers cross a render boundary before their target exists:
// StoryTab's "jump to node" expands a collapsed knot in the same tick
// it asks to scroll, and the Ship tab's readiness summary switches
// tabs first, so the panel it is aiming at is a tab-content swap away
// — and behind the destination tab's own data fetch, in AudioTab's
// case. Neither can await a render, so both poll.
//
// The poll is bounded, and the bound is a guess about how long a
// render (or a fetch) takes. Callers that can outlive their target —
// the author clicks a readiness row, then clicks somewhere else —
// should cancel with the returned function rather than let a stale
// timer yank the page later.

interface Options {
  /** How many times to re-look before giving up. The default suits a
   * target that only needs a render or two; a target behind a tab's
   * own data fetch needs a budget that outlasts the request. */
  attempts?: number;
  intervalMs?: number;
  block?: ScrollLogicalPosition;
}

/** Returns a cancel function; calling it stops any pending retry. */
export function scrollToSelector(
  selector: string,
  { attempts = 10, intervalMs = 50, block = 'center' }: Options = {},
): () => void {
  if (typeof document === 'undefined') return () => {};
  let remaining = attempts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tryScroll = () => {
    const el = document.querySelector(selector);
    if (el) {
      // A target that is itself a collapsed <details>, or lives inside
      // one, would scroll perfectly into view and still show nothing
      // but a twisty. Only same-document fragment navigation expands
      // those automatically, and this is a tab switch, not a jump to a
      // hash — so open it explicitly. (Panels that collapse via React
      // state instead are expanded by their own props; see StoryTab.)
      const details = el.closest('details');
      if (details) details.open = true;

      // Optional call: jsdom has no scrollIntoView, and a component
      // test that happens to render a matching element should not
      // blow up on a purely cosmetic side effect.
      el.scrollIntoView?.({ behavior: 'smooth', block });
      return;
    }
    if (remaining-- > 0) timer = setTimeout(tryScroll, intervalMs);
  };
  tryScroll();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
  };
}
