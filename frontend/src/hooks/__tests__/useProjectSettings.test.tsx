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
    expect(mockedFetch).toHaveBeenCalledWith('p1');
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
    mockedUpdate.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.updateOne('voiceoverVolume', 90);
    });

    expect(result.current.settings?.voiceoverVolume).toBe(40);
    expect(result.current.error).toMatch(/boom/);
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

  it('ignores a stale response that resolves after a newer save', async () => {
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

    // The user keeps dragging while #1 is still in flight, and that
    // second save goes out too.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 5000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(resolvers).toHaveLength(2);

    // #2 answers first, then #1 answers late with the value the user
    // has already moved past.
    await act(async () => {
      resolvers[1]({ settings: { choiceAudioDelayMs: 5000 } });
    });
    await act(async () => {
      resolvers[0]({ settings: { choiceAudioDelayMs: 2000 } });
    });

    // The control stays where the user left it instead of snapping back.
    expect(result.current.settings?.choiceAudioDelayMs).toBe(5000);
    vi.useRealTimers();
  });

  it('does not bounce the value back while a newer save is still pending', async () => {
    mockedFetch.mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } });
    const resolvers = deferredPatches();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useProjectSettings('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateDebounced('choiceAudioDelayMs', 2000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Moved again, but this time PATCH #1 answers before the new
    // debounce has even elapsed.
    act(() => result.current.updateDebounced('choiceAudioDelayMs', 5000));
    await act(async () => {
      resolvers[0]({ settings: { choiceAudioDelayMs: 2000 } });
    });

    expect(result.current.settings?.choiceAudioDelayMs).toBe(5000);
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
    expect(mockedUpdate).toHaveBeenLastCalledWith('p1', { choiceAudioDelayMs: 5000 });
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
    expect(mockedUpdate).toHaveBeenLastCalledWith('p1', { choiceAudioDelayMs: 5000 });
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
});
