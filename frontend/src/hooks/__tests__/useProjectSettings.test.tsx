import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectSettings } from '../useProjectSettings';

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
