import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMixAudition, MIX_TAIL_MS, type MixSpec } from '../useMixAudition';

class FakeAudio {
  static made: FakeAudio[] = [];
  loop = false;
  muted = false;
  volume = 1;
  paused = true;
  currentTime = 0;
  src: string;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src = '') {
    this.src = src;
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

const find = (src: string) => FakeAudio.made.filter((a) => a.src === src);
// Primed effects are started muted inside the click and then parked;
// "sounding" means actually audible.
const sounding = (src: string) => find(src).filter((a) => !a.paused && !a.muted);

const spec = (over: Partial<MixSpec> = {}): MixSpec => ({
  voiceUrl: 'vo',
  ambienceUrl: 'bed',
  sfx: [],
  voiceVolume: 1,
  ambienceVolume: 0.5,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudio.made = [];
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useMixAudition', () => {
  it('fires effects on the narration’s clock, the same way the player does', async () => {
    const { result } = renderHook(() => useMixAudition());
    await act(async () => {
      result.current.play(spec({ sfx: [{ url: 'door' }, { url: 'bell', offsetMs: 2000 }] }));
    });
    // Untimed: as the narration starts.
    expect(sounding('door')).toHaveLength(1);
    expect(sounding('bell')).toHaveLength(0);

    const voice = find('vo')[0];
    voice.currentTime = 2.1;
    act(() => voice.ontimeupdate?.());
    expect(sounding('bell')).toHaveLength(1);
    // Once only.
    act(() => voice.ontimeupdate?.());
    expect(find('bell')).toHaveLength(1);
  });

  // No timing means as the passage starts, not when the narration does;
  // an explicit 0 is on the narration's clock.
  it('plays untimed effects straight away and waits for the narration for timed ones', () => {
    const original = FakeAudio.prototype.play;
    FakeAudio.prototype.play = function (this: FakeAudio) {
      this.paused = false;
      // Narration that hasn't started yet.
      return this.src === 'vo' ? new Promise<void>(() => {}) : Promise.resolve();
    };
    try {
      const { result } = renderHook(() => useMixAudition());
      act(() => {
        result.current.play(spec({ sfx: [{ url: 'door' }, { url: 'bell', offsetMs: 0 }] }));
      });
      expect(sounding('door')).toHaveLength(1);
      expect(sounding('bell')).toHaveLength(0);
    } finally {
      FakeAudio.prototype.play = original;
    }
  });

  it('plays anything timed past the narration when it ends, lets it ring out, then stops', async () => {
    const { result } = renderHook(() => useMixAudition());
    await act(async () => {
      result.current.play(spec({ sfx: [{ url: 'bell', offsetMs: 60_000 }] }));
    });
    act(() => find('vo')[0].onended?.());
    expect(sounding('bell')).toHaveLength(1);
    // Still ringing: not cut off by the tail.
    act(() => {
      vi.advanceTimersByTime(MIX_TAIL_MS * 2);
    });
    expect(result.current.playing).toBe(true);
    act(() => find('bell')[0].onended?.());
    act(() => {
      vi.advanceTimersByTime(MIX_TAIL_MS);
    });
    expect(result.current.playing).toBe(false);
    expect(FakeAudio.made.every((a) => a.paused)).toBe(true);
  });

  it('doesn’t hang on an effect that fails to play', async () => {
    const { result } = renderHook(() => useMixAudition());
    await act(async () => {
      result.current.play(
        spec({ voiceUrl: undefined, ambienceUrl: undefined, sfx: [{ url: 'door' }] }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    act(() => find('door')[0].onerror?.());
    act(() => {
      vi.advanceTimersByTime(MIX_TAIL_MS);
    });
    expect(result.current.playing).toBe(false);
  });

  it('with no narration, times effects from the start and loops the bed until stopped', async () => {
    const { result } = renderHook(() => useMixAudition());
    await act(async () => {
      result.current.play(spec({ voiceUrl: undefined, sfx: [{ url: 'bell', offsetMs: 1000 }] }));
    });
    expect(find('bed')[0].loop).toBe(true);
    expect(sounding('bell')).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(sounding('bell')).toHaveLength(1);
    act(() => result.current.stop());
    expect(FakeAudio.made.every((a) => a.paused)).toBe(true);
  });

  // Safari only lets an element play from a user gesture, so every
  // effect is created and started (muted) inside the click, then parked.
  it('creates and primes every effect up front', async () => {
    const { result } = renderHook(() => useMixAudition());
    await act(async () => {
      result.current.play(spec({ sfx: [{ url: 'bell', offsetMs: 5000 }] }));
    });
    const [bell] = find('bell');
    expect(bell).toBeDefined();
    expect(bell.paused).toBe(true);
    expect(bell.muted).toBe(true);
  });

  it('ends an effects-only mix once the last effect has played', async () => {
    const { result } = renderHook(() => useMixAudition());
    await act(async () => {
      result.current.play(
        spec({ voiceUrl: undefined, ambienceUrl: undefined, sfx: [{ url: 'door' }] }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(sounding('door')).toHaveLength(1);
    act(() => find('door')[0].onended?.());
    act(() => {
      vi.advanceTimersByTime(MIX_TAIL_MS);
    });
    expect(result.current.playing).toBe(false);
  });

  it('stops rather than leaving the bed looping when the voiceover fails', async () => {
    const { result } = renderHook(() => useMixAudition());
    await act(async () => result.current.play(spec()));
    act(() => find('vo')[0].onerror?.());
    expect(result.current.playing).toBe(false);
    expect(find('bed')[0].paused).toBe(true);
  });

  it('keeps an out-of-range level from throwing', async () => {
    const { result } = renderHook(() => useMixAudition());
    await act(async () => result.current.play(spec({ ambienceVolume: 1.5, voiceVolume: -1 })));
    expect(find('bed')[0].volume).toBe(1);
    expect(find('vo')[0].volume).toBe(0);
  });

  it('starting again stops the previous mix first', async () => {
    const { result } = renderHook(() => useMixAudition());
    await act(async () => result.current.play(spec()));
    const first = [...FakeAudio.made];
    await act(async () => result.current.play(spec()));
    expect(first.every((a) => a.paused)).toBe(true);
    expect(sounding('bed')).toHaveLength(1);
  });

  it('silences everything on unmount', async () => {
    const { result, unmount } = renderHook(() => useMixAudition());
    await act(async () => result.current.play(spec({ sfx: [{ url: 'door' }] })));
    unmount();
    expect(FakeAudio.made.every((a) => a.paused)).toBe(true);
  });
});
