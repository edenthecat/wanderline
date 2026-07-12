import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAudition } from '../useAudition';

// pin the state transitions on the audition hook so a
// future refactor can't quietly regress the "click Play on file A,
// then Play on file B, only B plays" behavior.

interface FakeAudio {
  src: string;
  currentTime: number;
  ended: boolean;
  paused: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  addEventListener: (name: string, handler: () => void) => void;
  fireEvent: (name: string) => void;
  preload: string;
}

function makeFakeAudio(): FakeAudio {
  const listeners: Record<string, Array<() => void>> = {};
  const a: FakeAudio = {
    src: '',
    currentTime: 0,
    ended: false,
    paused: true,
    preload: '',
    play: vi.fn(() => {
      a.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      a.paused = true;
      // Fire 'pause' synchronously to mirror the real HTMLMediaElement
      // where consumers observe the paused state via the event.
      (listeners['pause'] ?? []).forEach((h) => h());
    }),
    addEventListener: (name, handler) => {
      (listeners[name] ??= []).push(handler);
    },
    fireEvent: (name) => (listeners[name] ?? []).forEach((h) => h()),
  };
  return a;
}

const originalAudio = globalThis.Audio;
let fakeAudio: FakeAudio;

beforeEach(() => {
  fakeAudio = makeFakeAudio();
  // useAudition calls `new Audio()` — replace the constructor with a
  // class that returns our fake so we can observe every play/pause/
  // src assignment and fire ended/error at the test's discretion.
  // Arrow functions can't be used as constructors, hence the class.
  class MockAudio {
    constructor() {
      return fakeAudio as unknown as MockAudio;
    }
  }
  (globalThis as unknown as { Audio: unknown }).Audio = MockAudio;
});

afterEach(() => {
  (globalThis as unknown as { Audio: unknown }).Audio = originalAudio;
});

describe('useAudition', () => {
  it('starts with no playing id', () => {
    const { result } = renderHook(() => useAudition());
    expect(result.current.playingId).toBeNull();
  });

  it('toggle(id, url) plays the file and sets playingId', () => {
    const { result } = renderHook(() => useAudition());
    act(() => result.current.toggle('a', '/audio/a'));
    expect(fakeAudio.src).toBe('/audio/a');
    expect(fakeAudio.play).toHaveBeenCalledTimes(1);
    expect(result.current.playingId).toBe('a');
  });

  it('toggle(id) on the currently playing id stops playback', () => {
    const { result } = renderHook(() => useAudition());
    act(() => result.current.toggle('a', '/audio/a'));
    act(() => result.current.toggle('a', '/audio/a'));
    expect(fakeAudio.pause).toHaveBeenCalled();
    expect(result.current.playingId).toBeNull();
  });

  it('toggle(other) auto-stops the current file and starts the new one', () => {
    const { result } = renderHook(() => useAudition());
    act(() => result.current.toggle('a', '/audio/a'));
    act(() => result.current.toggle('b', '/audio/b'));
    expect(fakeAudio.pause).toHaveBeenCalled(); // stopped 'a'
    expect(fakeAudio.src).toBe('/audio/b');
    expect(result.current.playingId).toBe('b');
  });

  it('clears playingId when the audio element fires ended', () => {
    const { result } = renderHook(() => useAudition());
    act(() => result.current.toggle('a', '/audio/a'));
    act(() => {
      fakeAudio.ended = true;
      fakeAudio.fireEvent('ended');
    });
    expect(result.current.playingId).toBeNull();
  });

  it('clears playingId when the audio element fires error', () => {
    const { result } = renderHook(() => useAudition());
    act(() => result.current.toggle('a', '/audio/a'));
    act(() => fakeAudio.fireEvent('error'));
    expect(result.current.playingId).toBeNull();
  });

  it('clears playingId when the play() promise rejects (autoplay policy etc.)', async () => {
    fakeAudio.play = vi.fn(() => Promise.reject(new Error('autoplay')));
    const { result } = renderHook(() => useAudition());
    await act(async () => {
      result.current.toggle('a', '/audio/a');
      // Let the rejection propagate.
      await Promise.resolve();
    });
    expect(result.current.playingId).toBeNull();
  });

  it('stop() halts playback and rewinds', () => {
    const { result } = renderHook(() => useAudition());
    act(() => result.current.toggle('a', '/audio/a'));
    act(() => {
      fakeAudio.currentTime = 42;
      result.current.stop();
    });
    expect(fakeAudio.pause).toHaveBeenCalled();
    expect(fakeAudio.currentTime).toBe(0);
    expect(result.current.playingId).toBeNull();
  });

  it('pauses the audio element on unmount', () => {
    const { result, unmount } = renderHook(() => useAudition());
    act(() => result.current.toggle('a', '/audio/a'));
    fakeAudio.pause.mockClear();
    unmount();
    expect(fakeAudio.pause).toHaveBeenCalled();
  });
});
