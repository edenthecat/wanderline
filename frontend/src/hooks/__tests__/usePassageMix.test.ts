import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePassageMix, type PassageMix } from '../usePassageMix';

// Transport behaviour for the in-context audition: what it starts, what
// it stops, and — the part that bites — that it never sits there
// claiming to play when nothing is sounding.

class MockAudio {
  static instances: MockAudio[] = [];
  src: string;
  volume = 1;
  loop = false;
  paused = true;
  playCalls = 0;
  /** When true, play() rejects the way an autoplay block does. */
  rejectPlay = false;
  private listeners: Record<string, (() => void)[]> = {};

  constructor(src?: string) {
    this.src = src ?? '';
    MockAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.playCalls += 1;
    if (this.rejectPlay) return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener() {}
  emit(type: string) {
    for (const fn of this.listeners[type] ?? []) fn();
  }
}

const originalAudio = globalThis.Audio;

function mixOf(overrides: Partial<PassageMix> = {}): PassageMix {
  return {
    lead: { url: '/audio/vo.mp3', gain: 1 },
    beds: [
      { url: '/audio/amb.mp3', gain: 0.3 },
      { url: '/audio/music.mp3', gain: 0.3 },
    ],
    ...overrides,
  };
}

const bySrc = (fragment: string) => MockAudio.instances.filter((a) => a.src.includes(fragment));

beforeEach(() => {
  MockAudio.instances = [];
  globalThis.Audio = MockAudio as unknown as typeof Audio;
});

afterEach(() => {
  globalThis.Audio = originalAudio;
});

describe('usePassageMix', () => {
  it('starts every layer at the gain it was handed, untouched', async () => {
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));

    expect(MockAudio.instances).toHaveLength(3);
    expect(MockAudio.instances.map((a) => a.volume)).toEqual([1, 0.3, 0.3]);
    expect(MockAudio.instances.every((a) => a.playCalls === 1)).toBe(true);
    expect(result.current.playing).toBe(true);
  });

  it('loops the beds but not the voiceover', async () => {
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));

    expect(bySrc('vo.mp3')[0].loop).toBe(false);
    expect(bySrc('amb.mp3')[0].loop).toBe(true);
    expect(bySrc('music.mp3')[0].loop).toBe(true);
  });

  it('stops everything it started, not just the voiceover', async () => {
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));
    await act(async () => result.current.stop());

    expect(MockAudio.instances.every((a) => a.paused)).toBe(true);
    expect(result.current.playing).toBe(false);
  });

  it('toggles off on a second call', async () => {
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));
    await act(async () => result.current.toggle(mixOf()));

    expect(result.current.playing).toBe(false);
    // No fourth element: the second toggle stopped, it didn't restart.
    expect(MockAudio.instances).toHaveLength(3);
  });

  it('ends the whole mix when the voiceover ends — the passage is over', async () => {
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));
    await act(async () => bySrc('vo.mp3')[0].emit('ended'));

    expect(result.current.playing).toBe(false);
    expect(MockAudio.instances.every((a) => a.paused)).toBe(true);
  });

  it('unwinds rather than hanging when the voiceover fails to load', async () => {
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));
    await act(async () => bySrc('vo.mp3')[0].emit('error'));

    expect(result.current.playing).toBe(false);
    expect(MockAudio.instances.every((a) => a.paused)).toBe(true);
  });

  it('keeps going when one bed fails — a missing bed is not a dead mix', async () => {
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));
    await act(async () => bySrc('amb.mp3')[0].emit('error'));

    expect(result.current.playing).toBe(true);
    expect(bySrc('vo.mp3')[0].paused).toBe(false);
  });

  // One dead file can report twice (an 'error' event AND a rejected
  // play()); counting it twice would take the surviving layers down.
  it('counts a layer out once even when it fails twice', async () => {
    const { result } = renderHook(() => usePassageMix());
    // No lead, two beds: one bed counted out twice would empty the
    // whole mix and silence the bed that is still playing fine.
    await act(async () => result.current.toggle(mixOf({ lead: null })));
    await act(async () => {
      bySrc('amb.mp3')[0].emit('error');
      bySrc('amb.mp3')[0].emit('error');
    });

    expect(result.current.playing).toBe(true);
    expect(bySrc('music.mp3')[0].paused).toBe(false);
  });

  it('gives up when every layer fails, leaving no stuck playing state', async () => {
    const { result } = renderHook(() => usePassageMix());
    // No lead: the "every bed died" path is the only way out here.
    await act(async () => result.current.toggle(mixOf({ lead: null })));
    expect(result.current.playing).toBe(true);

    await act(async () => {
      bySrc('amb.mp3')[0].emit('error');
      bySrc('music.mp3')[0].emit('error');
    });
    expect(result.current.playing).toBe(false);
  });

  it('unwinds when playback is refused outright (autoplay policy)', async () => {
    const { result } = renderHook(() => usePassageMix());
    const originalCtor = globalThis.Audio;
    globalThis.Audio = class extends MockAudio {
      constructor(src?: string) {
        super(src);
        this.rejectPlay = true;
      }
    } as unknown as typeof Audio;
    await act(async () => result.current.toggle(mixOf({ lead: null, beds: mixOf().beds })));
    globalThis.Audio = originalCtor;

    expect(result.current.playing).toBe(false);
  });

  // A synchronous throw unwinds the mix from inside the start loop.
  // Anything started after that is referenced by nothing, loops
  // forever, and no control can reach it.
  it('starts nothing more once a synchronous failure has torn the mix down', async () => {
    const originalCtor = globalThis.Audio;
    globalThis.Audio = class extends MockAudio {
      play(): Promise<void> {
        if (this.src.includes('vo.mp3')) throw new Error('sync failure');
        return super.play();
      }
    } as unknown as typeof Audio;
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));
    globalThis.Audio = originalCtor;

    expect(result.current.playing).toBe(false);
    expect(MockAudio.instances.every((a) => a.paused)).toBe(true);
    expect(bySrc('amb.mp3')[0].playCalls).toBe(0);
    expect(bySrc('music.mp3')[0].playCalls).toBe(0);
  });

  it('has nothing to play, and says so, for an empty mix', async () => {
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle({ lead: null, beds: [] }));

    expect(result.current.playing).toBe(false);
    expect(MockAudio.instances).toHaveLength(0);
  });

  // Switching passages or tabs unmounts the panel mid-play.
  it('stops everything on unmount', async () => {
    const { result, unmount } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));
    unmount();

    expect(MockAudio.instances.every((a) => a.paused)).toBe(true);
  });

  // A late rejection from a superseded mix must not stop the new one.
  it('ignores a failure reported by a mix that has already been replaced', async () => {
    const { result } = renderHook(() => usePassageMix());
    await act(async () => result.current.toggle(mixOf()));
    const stale = bySrc('vo.mp3')[0];
    await act(async () => result.current.stop());
    await act(async () => result.current.toggle(mixOf()));
    await act(async () => stale.emit('error'));

    expect(result.current.playing).toBe(true);
  });
});
