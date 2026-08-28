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
});

describe('scrollToSelector', () => {
  it('scrolls a target that is already mounted', () => {
    document.body.innerHTML = '<div id="target"></div>';
    scrollToSelector('#target');
    expect(document.getElementById('target')!.scrollIntoView).toHaveBeenCalled();
  });

  // Both callers ask to scroll in the same tick they trigger the
  // render that creates the target — a tab switch, or expanding a
  // collapsed knot — so a single look would always miss.
  it('keeps looking while the target is still rendering', () => {
    vi.useFakeTimers();
    scrollToSelector('#late');
    vi.advanceTimersByTime(200);
    document.body.innerHTML = '<div id="late"></div>';
    vi.advanceTimersByTime(200);
    expect(document.getElementById('late')!.scrollIntoView).toHaveBeenCalled();
  });

  it('gives up rather than polling forever', () => {
    vi.useFakeTimers();
    scrollToSelector('#never', { attempts: 3, intervalMs: 10 });
    vi.advanceTimersByTime(1000);
    document.body.innerHTML = '<div id="never"></div>';
    vi.advanceTimersByTime(1000);
    expect(document.getElementById('never')!.scrollIntoView).not.toHaveBeenCalled();
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
