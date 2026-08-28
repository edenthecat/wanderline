import { describe, expect, it, vi } from 'vitest';
import { claimAudio, releaseAudio } from '../exclusiveAudio';

// The floor itself. The editor-wide "one sound at a time" rule is only
// as good as this handful of lines, and the failure it prevents is
// silent: two players sounding at once, which is exactly what the
// in-context audition is supposed to let an author judge.

describe('exclusiveAudio', () => {
  it('stops the previous holder when someone else claims', () => {
    const first = vi.fn();
    const second = vi.fn();
    claimAudio(first);
    claimAudio(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    releaseAudio(second);
  });

  it('does not stop a holder re-claiming its own floor', () => {
    const only = vi.fn();
    claimAudio(only);
    claimAudio(only);

    expect(only).not.toHaveBeenCalled();
    releaseAudio(only);
  });

  // A real stop() releases on its way out. If the claim were recorded
  // before that ran, the incoming player would immediately lose the
  // floor it had just taken.
  it('survives a holder that releases from inside its own stop', () => {
    const releasing = vi.fn(() => releaseAudio(releasing));
    const next = vi.fn();
    claimAudio(releasing);
    claimAudio(next);
    // The floor is `next`'s: a third claim must stop it.
    const third = vi.fn();
    claimAudio(third);

    expect(next).toHaveBeenCalledTimes(1);
    releaseAudio(third);
  });

  it('releases only for the current holder', () => {
    const holder = vi.fn();
    const other = vi.fn();
    claimAudio(holder);
    releaseAudio(other); // not the holder — must not clear the claim

    const next = vi.fn();
    claimAudio(next);
    expect(holder).toHaveBeenCalledTimes(1);
    releaseAudio(next);
  });

  it('has nothing to stop once the floor is given up', () => {
    const gone = vi.fn();
    claimAudio(gone);
    releaseAudio(gone);
    claimAudio(vi.fn());

    expect(gone).not.toHaveBeenCalled();
  });
});
