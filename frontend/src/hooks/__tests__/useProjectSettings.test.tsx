import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectSettings } from '../useProjectSettings';
import type { ProjectSettings } from '../../api/client';

// end-to-end hook coverage for the optimistic-update path.
// The hook mounts, reads server state, PATCHes on updateOne, rolls
// back on failure — exactly the flows every Settings section reads.

vi.mock('../../api/client', () => ({
  fetchProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
}));

// Import the mocked module AFTER vi.mock so the mocks resolve.
const { fetchProjectSettings, updateProjectSettings } = await import('../../api/client');
const mockedFetch = vi.mocked(fetchProjectSettings);
const mockedUpdate = vi.mocked(updateProjectSettings);

beforeEach(() => {
  mockedFetch.mockReset();
  mockedUpdate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useProjectSettings', () => {
  it('loads settings on mount', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { voiceoverVolume: 60 } });
    const { result } = renderHook(() => useProjectSettings('p1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings).toEqual({ voiceoverVolume: 60 });
    expect(mockedFetch).toHaveBeenCalledWith('p1', expect.any(AbortSignal));
  });

  it('updateOne is optimistic — the local value flips before the round-trip resolves', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { voiceoverVolume: 40 } });
    // Delay the PATCH so we can observe the optimistic state in
    // between: capture the resolver up front.
    let resolvePatch!: (v: { settings: { voiceoverVolume: number } }) => void;
    mockedUpdate.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolvePatch = res;
        }),
    );

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      // Don't await: we want to see the optimistic state first.
      void result.current.updateOne('voiceoverVolume', 80);
    });
    // Optimistic: local state jumped to 80 immediately.
    expect(result.current.settings?.voiceoverVolume).toBe(80);

    // Server confirms with a normalized value (say the backend snaps
    // to nearest 5).
    await act(async () => {
      resolvePatch({ settings: { voiceoverVolume: 80 } });
    });
    expect(result.current.settings?.voiceoverVolume).toBe(80);
  });

  it('rolls back updateOne when the PATCH fails', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { voiceoverVolume: 40 } });
    // The rollback below also resends the value it rolls back to (see
    // the "resends the value…" test), so a second PATCH follows the
    // first — mocked here to succeed, so this test can also cover that
    // the resend clears the error the original failure left up.
    mockedUpdate
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ settings: { voiceoverVolume: 40 } });
    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.updateOne('voiceoverVolume', 90);
    });

    expect(result.current.settings?.voiceoverVolume).toBe(40);
    // The automatic resend below tends to have already succeeded by
    // this point (rather than leaving 'boom' up to observe), resolving
    // the failure that triggered it.
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it('reload() re-fetches when called manually', async () => {
    mockedFetch
      .mockResolvedValueOnce({ settings: { voiceoverVolume: 40 } })
      .mockResolvedValueOnce({ settings: { voiceoverVolume: 60 } });
    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings?.voiceoverVolume).toBe(40);

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.settings?.voiceoverVolume).toBe(60);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('updateDebounced flips local state immediately and does not PATCH synchronously', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { voiceoverVolume: 40 } });
    mockedUpdate.mockResolvedValue({ settings: { voiceoverVolume: 75 } });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.updateDebounced('voiceoverVolume', 75);
    });
    // Optimistic: local state moved immediately.
    expect(result.current.settings?.voiceoverVolume).toBe(75);
    // But the PATCH is scheduled behind the 250ms debounce, so it
    // hasn't fired yet on the same tick.
    expect(mockedUpdate).not.toHaveBeenCalled();
  });
});

// A slider is the one control that can have two saves of the same key
// outstanding at once: the debounce timer fires mid-drag and the user
// keeps moving. Nothing makes those PATCHes resolve in the order they
// were sent, and the endpoint answers each with the whole merged
// settings object, so an out-of-order or cross-key response used to be
// written back verbatim over newer state.
describe('useProjectSettings — overlapping saves', () => {
  /** A PATCH mock whose responses resolve only when you say so. */
  function deferredPatches() {
    const resolvers: Array<(v: { settings: ProjectSettings }) => void> = [];
    mockedUpdate.mockImplementation(
      () =>
        new Promise((res) => {
          resolvers.push(res as (v: { settings: ProjectSettings }) => void);
        }),
    );
    return resolvers;
  }

  it('does not apply a response the user has already moved past', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } });
    const resolvers = deferredPatches();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // First drag, debounce elapses, PATCH #1 goes out.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 2000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(resolvers).toHaveLength(1);

    // The user keeps dragging while #1 is still unanswered, then #1
    // finally answers with the value they have already moved past.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 5000));
    await act(async () => {
      resolvers[0]({ settings: { choiceAudioDelayMs: 2000 } });
    });

    // The control stays where the user left it instead of snapping back
    // for the length of the next debounce.
    expect(result.current.settings?.choiceAudioDelayMs).toBe(5000);
    vi.useRealTimers();
  });

  // Dropping a stale *response* keeps the editor honest but not the
  // database. mergeSettings serialises concurrent writes with
  // SELECT … FOR UPDATE, so whichever request arrives last wins — two
  // same-key PATCHes in flight could leave the stored pause on the older
  // value while the editor showed the newer one, a desync that would only
  // surface on the next reload.
  it('sends same-key saves one at a time so they cannot arrive out of order', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } });
    const resolvers = deferredPatches();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateDebounced('choiceAudioDelayMs', 2000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockedUpdate).toHaveBeenCalledTimes(1);

    // A second drag, and its own debounce elapses while #1 is still
    // unanswered. It has to queue rather than race #1 to the endpoint.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 5000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockedUpdate).toHaveBeenCalledTimes(1);

    // Once #1 lands, the queued save goes out.
    await act(async () => {
      resolvers[0]({ settings: { choiceAudioDelayMs: 2000 } });
    });
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedUpdate).toHaveBeenLastCalledWith(
      'p1',
      { choiceAudioDelayMs: 5000 },
      expect.any(AbortSignal),
    );
    vi.useRealTimers();
  });

  // The hook lives on a route that swaps projectId without remounting, so
  // the refs behind all of this survive a project switch. Retiring the old
  // project's generations by clearing the per-key map was not enough on
  // its own: counters restarting from 1 meant the new project's first save
  // claimed the same number the old project's in-flight save was holding,
  // and that save's response then wrote the old project's value here.
  it('a save from the previous project cannot land on the next one', async () => {
    mockedFetch
      .mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 1000 } })
      .mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 7000 } });
    const resolvers = deferredPatches();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result, rerender } = renderHook(({ id }) => useProjectSettings(id), {
      initialProps: { id: 'project-a' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A save for project A goes out and stays unanswered.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 1000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(resolvers).toHaveLength(1);

    rerender({ id: 'project-b' });
    await waitFor(() => expect(result.current.settings?.choiceAudioDelayMs).toBe(7000));

    // The author moves project B's slider, which claims the key again.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 6000));

    // Project A's response finally arrives.
    await act(async () => {
      resolvers[0]({ settings: { choiceAudioDelayMs: 1000 } });
    });

    expect(result.current.settings?.choiceAudioDelayMs).toBe(6000);
    vi.useRealTimers();
  });

  // A finished request used to clear the debounce entry for its key —
  // including a timer some later onChange had put there in the meantime.
  // The next onChange then found nothing to cancel, so the orphaned
  // timer fired anyway and a second PATCH ran alongside it, saving a
  // value the user had already moved past.
  it('a resolved save does not orphan the debounce timer queued behind it', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } });
    let resolveFirst!: (v: { settings: ProjectSettings }) => void;
    mockedUpdate
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res as (v: { settings: ProjectSettings }) => void;
          }),
      )
      .mockResolvedValue({ settings: { choiceAudioDelayMs: 5000 } });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // PATCH #1 goes out and stays in flight.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 2000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockedUpdate).toHaveBeenCalledTimes(1);

    // A second drag schedules a save behind it...
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 4000));
    // ...and #1 answers while that timer is still pending.
    await act(async () => {
      resolveFirst({ settings: { choiceAudioDelayMs: 2000 } });
    });
    // A third drag has to still be able to cancel that pending timer.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 5000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // One further PATCH, not two, and it carries the value the drag
    // ended on.
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedUpdate).toHaveBeenLastCalledWith(
      'p1',
      { choiceAudioDelayMs: 5000 },
      expect.any(AbortSignal),
    );
    expect(result.current.settings?.choiceAudioDelayMs).toBe(5000);
    vi.useRealTimers();
  });

  it('keeps a failure from a superseded save off screen', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } });
    let rejectFirst!: (e: Error) => void;
    mockedUpdate
      .mockImplementationOnce(
        () =>
          new Promise((_res, rej) => {
            rejectFirst = rej;
          }),
      )
      .mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 5000 } });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateDebounced('choiceAudioDelayMs', 2000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The second drag claims the key before the first save's rejection
    // is delivered, so that rejection is about a value nobody is looking
    // at any more. Surfacing it would put an error banner over a control
    // whose newer save is still on its way.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 5000));
    await act(async () => {
      rejectFirst(new Error('network blip'));
    });

    expect(result.current.error).toBeNull();
    expect(result.current.settings?.choiceAudioDelayMs).toBe(5000);

    // ...and the save that replaced it still runs and still lands.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockedUpdate).toHaveBeenLastCalledWith(
      'p1',
      { choiceAudioDelayMs: 5000 },
      expect.any(AbortSignal),
    );
    expect(result.current.error).toBeNull();
    vi.useRealTimers();
  });

  // The endpoint answers every PATCH with the whole merged object, which
  // by definition doesn't know about a change to a *different* key made
  // after the request left. Writing it back wholesale silently reverted
  // that other key — the hook's own docs promise these are independent.
  it('a save for one key does not revert another key changed mid-flight', async () => {
    mockedFetch.mockResolvedValueOnce({
      settings: { voiceoverVolume: 40, choiceAudioDelayMs: 3000 },
    });
    const resolvers = deferredPatches();

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      void result.current.updateOne('voiceoverVolume', 80);
    });
    act(() => {
      void result.current.updateOne('choiceAudioDelayMs', 1500);
    });

    // The volume PATCH answers with the object as the server knew it —
    // before it had heard about the new pause.
    await act(async () => {
      resolvers[0]({ settings: { voiceoverVolume: 80, choiceAudioDelayMs: 3000 } });
    });

    expect(result.current.settings?.voiceoverVolume).toBe(80);
    expect(result.current.settings?.choiceAudioDelayMs).toBe(1500);
  });

  // The endpoint clamps choiceAudioDelayMs to >= 0, so the response is
  // the authority on what actually got stored — not the value we sent.
  it('adopts the value the server normalized to', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } });
    mockedUpdate.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 0 } });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.updateOne('choiceAudioDelayMs', -500);
    });

    expect(result.current.settings?.choiceAudioDelayMs).toBe(0);
  });

  // updateOne's generation guard is safe for a scalar — the newest call
  // carries the complete value, so skipping an older one loses nothing.
  // choiceIndicatorAudio breaks that assumption: SystemSoundsTab patches
  // one side at a time (`{ choice2FileId: 'b' }`), so a superseded call
  // is not a stale duplicate of the next one, it's a *different*
  // sub-field that nothing else will ever send. Skipping it — as an
  // earlier version of this generation guard did — silently dropped
  // that sub-field. Only the *response* may be superseded; every request
  // has to go out.
  it('sends every patch for a key even when a newer one supersedes it while queued', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: {} });
    const resolvers = deferredPatches();

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Three edits to two different sub-fields of one nested key, fired
    // before any of them has answered — choice 1, then choice 2, then
    // choice 1 again.
    act(() => {
      void result.current.updateOne('choiceIndicatorAudio', { choice1FileId: 'a' });
    });
    act(() => {
      void result.current.updateOne('choiceIndicatorAudio', { choice2FileId: 'b' });
    });
    act(() => {
      void result.current.updateOne('choiceIndicatorAudio', { choice1FileId: 'c' });
    });

    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    act(() => resolvers[0]({ settings: { choiceIndicatorAudio: { choice1FileId: 'a' } } }));

    // The choice-2 patch is not skipped just because a third call for
    // choice 1 had already superseded it by the time its turn came.
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate).toHaveBeenNthCalledWith(
      2,
      'p1',
      { choiceIndicatorAudio: { choice2FileId: 'b' } },
      expect.any(AbortSignal),
    );

    act(() =>
      resolvers[1]({
        settings: { choiceIndicatorAudio: { choice1FileId: 'a', choice2FileId: 'b' } },
      }),
    );
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(3));
    expect(mockedUpdate).toHaveBeenNthCalledWith(
      3,
      'p1',
      { choiceIndicatorAudio: { choice1FileId: 'c' } },
      expect.any(AbortSignal),
    );

    // The server processed the patches in the order they were sent, so
    // by the time the last (current) one answers, its response reflects
    // both edits correctly merged.
    await act(async () => {
      resolvers[2]({
        settings: { choiceIndicatorAudio: { choice1FileId: 'c', choice2FileId: 'b' } },
      });
    });
    expect(result.current.settings?.choiceIndicatorAudio).toEqual({
      choice1FileId: 'c',
      choice2FileId: 'b',
    });
  });

  // A finished request clears its own key's error, but a *successful*
  // one has to clear a failure left behind by an earlier attempt too —
  // otherwise a transient blip's error banner outlives the retry that
  // fixed it, telling the author their change didn't save when it did.
  it('clears a stale error once a later save for the same key succeeds', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } });
    mockedUpdate
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 5000 } });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateDebounced('choiceAudioDelayMs', 2000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.error).toMatch(/network blip/);

    act(() => result.current.updateDebounced('choiceAudioDelayMs', 5000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.settings?.choiceAudioDelayMs).toBe(5000);
    vi.useRealTimers();
  });

  // Chaining same-key saves fixes them arriving out of order, but it
  // also means a predecessor that never settles — a dropped connection,
  // a stalled proxy — would otherwise wedge every later save of that key
  // behind it forever, silently. There has to be a point where a save
  // stops waiting and goes anyway.
  it('stops waiting on a stuck predecessor and saves anyway', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } });
    // The first PATCH never settles — simulates a stalled connection.
    mockedUpdate.mockImplementationOnce(() => new Promise(() => {}));
    mockedUpdate.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 5000 } });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateDebounced('choiceAudioDelayMs', 2000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockedUpdate).toHaveBeenCalledTimes(1);

    act(() => result.current.updateDebounced('choiceAudioDelayMs', 5000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // Its own debounce has elapsed, but it's still queued behind the
    // stuck first save.
    expect(mockedUpdate).toHaveBeenCalledTimes(1);

    // Once the stuck-predecessor timeout passes, it stops waiting.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedUpdate).toHaveBeenLastCalledWith(
      'p1',
      { choiceAudioDelayMs: 5000 },
      expect.any(AbortSignal),
    );
    expect(result.current.settings?.choiceAudioDelayMs).toBe(5000);
    vi.useRealTimers();
  });

  // A scalar key's debounced save is delayed behind its own 250ms timer
  // before it ever touches runSerialized, so a plain updateOne call for
  // the *same* key made in between can reach the server first even
  // though it was claimed second. If the older, now-stale debounced
  // save were still sent once its timer finally fires, it would arrive
  // at the server after the newer value and silently overwrite it —
  // invisible in the editor, since the response-side generation check
  // already keeps the display correct regardless.
  it('does not let a stale debounced save reach the server after a newer plain save wins', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { voiceoverVolume: 40 } });
    mockedUpdate
      .mockResolvedValueOnce({ settings: { voiceoverVolume: 80 } })
      .mockResolvedValueOnce({ settings: { voiceoverVolume: 60 } });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A debounced save is scheduled but its timer hasn't fired yet.
    act(() => result.current.updateDebounced('voiceoverVolume', 60));
    // Before it does, a direct call for the same key sends immediately
    // and wins.
    await act(async () => {
      await result.current.updateOne('voiceoverVolume', 80);
    });
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(mockedUpdate).toHaveBeenCalledWith(
      'p1',
      { voiceoverVolume: 80 },
      expect.any(AbortSignal),
    );

    // The original debounce timer fires now. Its value is older than
    // what the server already has; it must not go out at all.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(result.current.settings?.voiceoverVolume).toBe(80);
    vi.useRealTimers();
  });

  // choiceIndicatorAudio's patches are fragments (see PARTIAL_PATCH_KEYS),
  // so a superseded call's *failure* isn't a stale duplicate the way a
  // superseded call's success is — nothing else is ever going to resend
  // that fragment. Swallowing the failure the way a scalar key's is
  // swallowed would silently lose the edit with no error shown.
  it('surfaces a partial-patch failure even once a newer save has taken over the key', async () => {
    mockedFetch.mockResolvedValueOnce({
      settings: { choiceIndicatorAudio: { choice1FileId: 'x', choice2FileId: 'y' } },
    });
    let rejectFirst!: (e: Error) => void;
    // choice2's own request is left pending deliberately, so it hasn't
    // answered yet at the point this test checks `settings` below — if
    // it had, its own (entirely correct) response would overwrite
    // whatever's there regardless, masking the thing being tested here.
    let resolveSecond!: (v: { settings: { choiceIndicatorAudio: Record<string, string> } }) => void;
    mockedUpdate
      .mockImplementationOnce(
        () =>
          new Promise((_res, rej) => {
            rejectFirst = rej;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveSecond = res;
          }),
      );

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      void result.current.updateOne('choiceIndicatorAudio', { choice1FileId: 'a' });
    });
    act(() => {
      void result.current.updateOne('choiceIndicatorAudio', { choice2FileId: 'b' });
    });

    await act(async () => {
      rejectFirst(new Error('choice 1 failed'));
    });

    expect(result.current.error).toMatch(/choice 1 failed/);
    // choice1 reverts to its own true pre-edit value ('x') regardless of
    // no longer being the current generation (choice2's call already
    // claimed that) — safe specifically because the revert only ever
    // touches the sub-field *this* call introduced, so it can't disturb
    // choice2's own still-pending optimistic 'b'.
    expect(result.current.settings?.choiceIndicatorAudio).toEqual({
      choice1FileId: 'x',
      choice2FileId: 'b',
    });

    // Let choice2's own request resolve too, so nothing's left hanging.
    await act(async () => {
      resolveSecond({ settings: { choiceIndicatorAudio: { choice2FileId: 'b' } } });
    });
  });

  // A partial-patch key's rollback target is only ever a fragment — one
  // sub-field's worth — never the key's complete value, so writing it
  // back into `settings[key]` as if it were complete would wipe out
  // whatever sub-field the failing call didn't touch. Reproduces the
  // exact interleaving: choice1's call succeeds but is superseded before
  // its response lands (so lastValueRef, at the moment choice2's call
  // captures its own "before" snapshot, holds only choice1's fragment,
  // not the full stored object); choice2's call then fails.
  // The common case: one edit, no concurrency at all. lastValueRef holds
  // the complete pre-edit object (nothing has fragmented it yet), so a
  // failure here has a genuinely safe, complete value to roll back to —
  // an earlier version of this fix missed that distinction and treated
  // every partial-patch failure as unrecoverable, which blanked the
  // untouched sub-field even in this, the most ordinary case.
  it('rolls a single failed partial-patch edit back to the complete pre-edit object', async () => {
    mockedFetch.mockResolvedValueOnce({
      settings: { choiceIndicatorAudio: { choice1FileId: 'x', choice2FileId: 'y' } },
    });
    mockedUpdate.mockRejectedValueOnce(new Error('choice 1 failed'));

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.updateOne('choiceIndicatorAudio', { choice1FileId: 'a' });
    });

    expect(result.current.error).toMatch(/choice 1 failed/);
    // Not just "choice1FileId reverted" — the untouched choice2FileId
    // must still be there too, not blanked by a bare-fragment rollback.
    expect(result.current.settings?.choiceIndicatorAudio).toEqual({
      choice1FileId: 'x',
      choice2FileId: 'y',
    });
  });

  // The concurrent case: choice1's edit succeeds but is superseded
  // before its response lands (so it never reaches applyServerValue),
  // and choice2's edit — which optimistically merged onto choice1's own
  // optimistic write, not replaced it — then fails. The rollback target
  // captured at choice2's own start is therefore already the correctly
  // merged {choice1: 'a', choice2: 'y'}, not a bare fragment of either
  // side.
  it('rolls a failed partial-patch edit back to the other sub-field’s own successful, merged edit', async () => {
    mockedFetch.mockResolvedValueOnce({
      settings: { choiceIndicatorAudio: { choice1FileId: 'x', choice2FileId: 'y' } },
    });
    mockedUpdate
      .mockResolvedValueOnce({
        settings: { choiceIndicatorAudio: { choice1FileId: 'a', choice2FileId: 'y' } },
      })
      .mockRejectedValueOnce(new Error('choice 2 failed'));

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let call1!: Promise<void>;
    let call2!: Promise<void>;
    act(() => {
      call1 = result.current.updateOne('choiceIndicatorAudio', { choice1FileId: 'a' });
      call2 = result.current.updateOne('choiceIndicatorAudio', { choice2FileId: 'b' });
    });
    await act(async () => {
      await Promise.all([call1, call2]);
    });

    expect(result.current.error).toMatch(/choice 2 failed/);
    // choice1's successful edit survives; choice2 reverts to its own
    // pre-edit value rather than being left at the failed 'b' or wiped
    // to nothing.
    expect(result.current.settings?.choiceIndicatorAudio).toEqual({
      choice1FileId: 'a',
      choice2FileId: 'y',
    });
  });

  // Neither edit ever reaches the server this time — unlike the test
  // above, where choice1's edit succeeds. originalValue for choice2's
  // own call is captured *after* choice1's optimistic merge, so it's
  // {choice1FileId:'a', choice2FileId:'y'} — itself an unconfirmed
  // guess, since choice1's call hasn't failed (or succeeded) yet at
  // that point. If choice2's rollback ever restored that whole snapshot
  // wholesale, it would resurrect choice1's own about-to-fail edit as
  // if it had been saved. The targeted revert never does: each call
  // only ever touches the sub-field it owns, so the two failures
  // combined correctly land back on the true, fully-unedited object.
  it('never shows either sub-field’s edit as saved when both fail', async () => {
    mockedFetch.mockResolvedValueOnce({
      settings: { choiceIndicatorAudio: { choice1FileId: 'x', choice2FileId: 'y' } },
    });
    mockedUpdate
      .mockRejectedValueOnce(new Error('choice 1 failed'))
      .mockRejectedValueOnce(new Error('choice 2 failed'));

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let call1!: Promise<void>;
    let call2!: Promise<void>;
    act(() => {
      call1 = result.current.updateOne('choiceIndicatorAudio', { choice1FileId: 'a' });
      call2 = result.current.updateOne('choiceIndicatorAudio', { choice2FileId: 'b' });
    });
    await act(async () => {
      await Promise.all([call1, call2]);
    });

    expect(result.current.error).toMatch(/choice 2 failed/);
    expect(result.current.settings?.choiceIndicatorAudio).toEqual({
      choice1FileId: 'x',
      choice2FileId: 'y',
    });
  });

  // The *same* sub-field edited twice in a row, both attempts failing.
  // The second attempt's own "before" snapshot is the first attempt's
  // optimistic value — itself never confirmed — so a revert that
  // trusted that snapshot would land one failed attempt short of the
  // true original, not on it: displaying choice1FileId as 'a' (the
  // first, also-failed attempt) instead of 'x' (what the server has
  // actually always held). Reverting to confirmedValueRef instead of a
  // captured-at-call-start snapshot is what keeps this correct
  // regardless of how many failed attempts a field has been through.
  it('reverts a repeatedly-failed sub-field to the true original, not the previous failed attempt', async () => {
    mockedFetch.mockResolvedValueOnce({
      settings: { choiceIndicatorAudio: { choice1FileId: 'x', choice2FileId: 'y' } },
    });
    mockedUpdate
      .mockRejectedValueOnce(new Error('first choice1 attempt failed'))
      .mockRejectedValueOnce(new Error('second choice1 attempt failed'));

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let call1!: Promise<void>;
    let call2!: Promise<void>;
    act(() => {
      call1 = result.current.updateOne('choiceIndicatorAudio', { choice1FileId: 'a' });
      call2 = result.current.updateOne('choiceIndicatorAudio', { choice1FileId: 'b' });
    });
    await act(async () => {
      await Promise.all([call1, call2]);
    });

    expect(result.current.error).toMatch(/second choice1 attempt failed/);
    expect(result.current.settings?.choiceIndicatorAudio).toEqual({
      choice1FileId: 'x',
      choice2FileId: 'y',
    });
  });

  // No current caller debounces a partial-patch key, but saveNow's own
  // failure handling has to be correct anyway — same revert as
  // updateOne's, for the same reason.
  it('reverts just its own sub-field when a debounced partial-patch save fails', async () => {
    mockedFetch.mockResolvedValueOnce({
      settings: { choiceIndicatorAudio: { choice1FileId: 'x', choice2FileId: 'y' } },
    });
    mockedUpdate.mockRejectedValueOnce(new Error('choice 1 failed'));
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateDebounced('choiceIndicatorAudio', { choice1FileId: 'a' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.error).toMatch(/choice 1 failed/);
    expect(result.current.settings?.choiceIndicatorAudio).toEqual({
      choice1FileId: 'x',
      choice2FileId: 'y',
    });
    vi.useRealTimers();
  });

  // The scalar skip in saveNow (see PARTIAL_PATCH_KEYS) assumes the
  // newer call it superseded will succeed. If that newer call fails and
  // rolls back to the debounced value instead, the debounced save's own
  // send was already skipped for being "superseded" — without a resend,
  // the server ends up with neither value: not the one that failed, and
  // not the one the editor rolled back to display.
  it('resends the value a superseded debounced save was skipped for, once a failing updateOne rolls back to it', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { voiceoverVolume: 40 } });
    mockedUpdate
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ settings: { voiceoverVolume: 60 } });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A debounced save (60) is scheduled but hasn't fired yet.
    act(() => result.current.updateDebounced('voiceoverVolume', 60));
    // A direct call (90) sends immediately, ahead of it, and fails.
    await act(async () => {
      await result.current.updateOne('voiceoverVolume', 90);
    });
    // The failure rolls the display back to 60 — the debounced value —
    // and a second request should carry it to the server.
    expect(result.current.settings?.voiceoverVolume).toBe(60);
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate).toHaveBeenLastCalledWith(
      'p1',
      { voiceoverVolume: 60 },
      expect.any(AbortSignal),
    );
  });

  // Giving up on a stuck predecessor (STUCK_SAVE_TIMEOUT_MS) has to
  // actually cancel its request, not just stop waiting for it — the
  // whole point is a request that never reached the server in the first
  // place (a dropped connection), and only cancelling it closes that
  // case rather than leaving two requests in flight at once.
  it('aborts a stuck predecessor once its timeout is reached', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } });
    let firstSignal: AbortSignal | undefined;
    mockedUpdate.mockImplementationOnce((...args) => {
      firstSignal = args[2] as AbortSignal;
      return new Promise(() => {});
    });
    mockedUpdate.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 5000 } });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateDebounced('choiceAudioDelayMs', 2000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    act(() => result.current.updateDebounced('choiceAudioDelayMs', 5000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // Still queued behind the stuck predecessor.
    expect(mockedUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  // Clearing the per-key maps on a project switch stops a stale
  // *response* from being displayed, but it doesn't by itself stop the
  // *request* underneath it from still being in flight — this is what
  // actually cancels it, so it can't land at the server after the next
  // project's own load or save already has.
  it('aborts an outstanding reload and save when the project switches away', async () => {
    let projectASignal: AbortSignal | undefined;
    let saveASignal: AbortSignal | undefined;
    mockedFetch.mockImplementation((id: unknown, signal?: unknown) => {
      if (id === 'project-a') {
        projectASignal = signal as AbortSignal;
        return new Promise(() => {});
      }
      return Promise.resolve({ settings: { choiceAudioDelayMs: 3000 } }) as never;
    });
    mockedUpdate.mockImplementation((..._args: unknown[]) => {
      saveASignal = _args[2] as AbortSignal;
      return new Promise(() => {});
    });

    const { result, rerender } = renderHook(({ id }) => useProjectSettings(id), {
      initialProps: { id: 'project-a' },
    });
    act(() => {
      void result.current.updateOne('choiceAudioDelayMs', 1000);
    });

    expect(projectASignal?.aborted).toBe(false);
    expect(saveASignal?.aborted).toBe(false);

    rerender({ id: 'project-b' });

    expect(projectASignal?.aborted).toBe(true);
    expect(saveASignal?.aborted).toBe(true);
  });

  // Two updateOne calls for the same key, with no render between them —
  // a bulk-apply handler, or two controls firing in the same tick — is
  // exactly the case a `settings`-via-closure read of the rollback
  // target gets wrong: both calls would read the same pre-either-of-them
  // value, so if the first succeeds and the second then fails, the
  // second's rollback (and resend) would clobber the first call's
  // already-confirmed write back down to a value the server never
  // actually held.
  it('rolls back to the first call’s confirmed value, not a stale pre-both value, when two updateOne calls for one key land without a render in between', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { voiceoverVolume: 50 } });
    mockedUpdate
      .mockResolvedValueOnce({ settings: { voiceoverVolume: 60 } }) // call1(60) succeeds
      .mockRejectedValueOnce(new Error('boom')) // call2(70) fails
      .mockResolvedValueOnce({ settings: { voiceoverVolume: 60 } }); // call2's resend

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let call1!: Promise<void>;
    let call2!: Promise<void>;
    act(() => {
      call1 = result.current.updateOne('voiceoverVolume', 60);
      call2 = result.current.updateOne('voiceoverVolume', 70);
    });
    await act(async () => {
      await Promise.all([call1, call2]);
    });

    // Rolled back to 60 — what call1 actually got the server to store —
    // not 50, the value from before either call.
    expect(result.current.settings?.voiceoverVolume).toBe(60);
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(3));
    expect(mockedUpdate).toHaveBeenLastCalledWith(
      'p1',
      { voiceoverVolume: 60 },
      expect.any(AbortSignal),
    );
  });
});
