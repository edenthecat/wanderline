// Scroll an element into view that may not be mounted yet.
//
// Both callers cross a render boundary before their target exists:
// StoryTab's "jump to node" expands a collapsed knot in the same tick
// it asks to scroll, and the Ship tab's readiness summary switches
// tabs first, so the panel it is aiming at is a tab-content swap away
// — and behind that tab's own data fetch, in AudioTab's case, which
// takes as long as the network does.
//
// So this watches for the target rather than guessing how long it will
// take to arrive: look once, and otherwise scroll the moment it
// mounts. The timeout is a lifetime bound on the watch, not a deadline
// the target has to beat — a slow project load used to mean the author
// clicked a readiness row and was silently left at the top of the tab.
//
// Callers that can outlive their target — the author clicks a
// readiness row, then clicks somewhere else — should cancel with the
// returned function rather than let a stale watch yank the page later.

interface Options {
  /** Stop watching after this long. Reached only when the target never
   * appears at all; one that does mount is scrolled to immediately,
   * however long it took. */
  timeoutMs?: number;
  block?: ScrollLogicalPosition;
}

/** Returns a cancel function; calling it stops watching. */
export function scrollToSelector(
  selector: string,
  { timeoutMs = 10000, block = 'center' }: Options = {},
): () => void {
  if (typeof document === 'undefined') return () => {};

  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    observer?.disconnect();
    observer = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const tryScroll = (): boolean => {
    const el = document.querySelector(selector);
    if (!el) return false;
    // A target that is itself a collapsed <details>, or lives inside
    // one, would scroll perfectly into view and still show nothing but
    // a twisty. Only same-document fragment navigation expands those
    // automatically, and this is a tab switch, not a jump to a hash —
    // so open it explicitly. (Panels that collapse via React state
    // instead are expanded by their own props; see StoryTab.)
    const details = el.closest('details');
    if (details) details.open = true;
    // Optional call: jsdom has no scrollIntoView, and a component test
    // that happens to render a matching element should not blow up on
    // a purely cosmetic side effect.
    el.scrollIntoView?.({ behavior: 'smooth', block });
    stop();
    return true;
  };

  if (tryScroll()) return () => {};
  if (typeof MutationObserver === 'undefined') return () => {};

  observer = new MutationObserver(() => {
    tryScroll();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // Guarantees teardown even for a caller that ignores the canceller.
  timer = setTimeout(stop, timeoutMs);
  return stop;
}
