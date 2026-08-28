import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollToSelector } from '../scrollToPanel';

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom has no scrollIntoView; the helper calls it optionally, but
  // the tests want to observe that it was called.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // restoreAllMocks does not undo stubGlobal, and one test below
  // swaps matchMedia out.
  vi.unstubAllGlobals();
});

/** MutationObserver callbacks are delivered as microtasks. */
const flush = () => Promise.resolve();

describe('scrollToSelector', () => {
  it('scrolls a target that is already mounted', () => {
    document.body.innerHTML = '<div id="target"></div>';
    scrollToSelector('#target');
    expect(document.getElementById('target')!.scrollIntoView).toHaveBeenCalled();
  });

  // Both callers ask to scroll in the same tick they trigger the
  // render that creates the target — a tab switch, or expanding a
  // collapsed knot — so a single look would always miss.
  it('scrolls as soon as a target that was not there yet mounts', async () => {
    scrollToSelector('#late');
    document.body.innerHTML = '<div id="late"></div>';
    await flush();
    expect(document.getElementById('late')!.scrollIntoView).toHaveBeenCalled();
  });

  // The Audio anchors sit behind that tab's own data load, which takes
  // as long as the network does. A fixed retry budget used to lose
  // that race and silently leave the author at the top of the tab.
  it('waits out a slow destination rather than timing out on it', async () => {
    vi.useFakeTimers();
    scrollToSelector('#slow');
    // Longer than any plausible fixed retry budget.
    vi.advanceTimersByTime(8000);
    document.body.innerHTML = '<div id="slow"></div>';
    await flush();
    expect(document.getElementById('slow')!.scrollIntoView).toHaveBeenCalled();
  });

  it('stops watching once its lifetime bound is up', async () => {
    vi.useFakeTimers();
    scrollToSelector('#never', { timeoutMs: 100 });
    vi.advanceTimersByTime(500);
    document.body.innerHTML = '<div id="never"></div>';
    await flush();
    expect(document.getElementById('never')!.scrollIntoView).not.toHaveBeenCalled();
  });

  // The author clicks a readiness row, then clicks somewhere else
  // while the destination is still loading. Without a cancel, the
  // watch yanks the page out from under them when it finally arrives.
  it('stops watching once cancelled', async () => {
    const cancel = scrollToSelector('#late');
    cancel();
    document.body.innerHTML = '<div id="late"></div>';
    await flush();
    expect(document.getElementById('late')!.scrollIntoView).not.toHaveBeenCalled();
  });

  // The cancel is what lets a caller drop the watch when the author
  // starts navigating on their own; a stale watch landing seconds
  // later is an interruption, not help.
  it('can be cancelled after the watch is already armed', async () => {
    vi.useFakeTimers();
    const cancel = scrollToSelector('#slow');
    vi.advanceTimersByTime(3000);
    cancel();
    document.body.innerHTML = '<div id="slow"></div>';
    await flush();
    expect(document.getElementById('slow')!.scrollIntoView).not.toHaveBeenCalled();
  });

  // index.css already disables the start-node animation for readers
  // who ask for less motion; every deferred scroll in the editor comes
  // through here, so this is where they have to be honoured.
  it('does not animate the scroll for a reader who asked for less motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    document.body.innerHTML = '<div id="target"></div>';
    scrollToSelector('#target');
    expect(document.getElementById('target')!.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'auto' }),
    );
  });

  // The Audio tab's missing-voiceover list is a <details>. Scrolling a
  // collapsed one into view lands the author on a twisty, not on the
  // list they were sent to see — and a tab switch is not fragment
  // navigation, so nothing expands it for us.
  it('expands a collapsed <details> target', () => {
    document.body.innerHTML = '<details id="target"><summary>Nodes</summary><p>x</p></details>';
    const details = document.getElementById('target') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    scrollToSelector('#target');
    expect(details.open).toBe(true);
  });

  it('expands a <details> the target is nested inside', () => {
    document.body.innerHTML = '<details><summary>Nodes</summary><p id="target">x</p></details>';
    scrollToSelector('#target');
    expect(document.querySelector('details')!.open).toBe(true);
  });
});
