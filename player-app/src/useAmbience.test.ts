import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAmbience, AMBIENCE_FADE_MS, type UseAmbienceOptions } from './useAmbience';

class FakeAudio {
  loop = false;
  volume = 1;
  paused = true;
  constructor(public src: string) {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

let made: FakeAudio[];
const getElement = (url: string) => {
  const el = new FakeAudio(url);
  made.push(el);
  return el as unknown as HTMLAudioElement;
};

function render(initial: Partial<UseAmbienceOptions>) {
  return renderHook(
    (props: Partial<UseAmbienceOptions>) =>
      useAmbience({ url: null, volume: 0.5, getElement, ...props }),
    {
      initialProps: initial,
    },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  made = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAmbience', () => {
  it('starts the bed looping and fades it up to the level', () => {
    render({ url: 'rain.mp3' });
    const [rain] = made;
    expect(rain.loop).toBe(true);
    expect(rain.paused).toBe(false);
    expect(rain.volume).toBe(0);
    vi.advanceTimersByTime(AMBIENCE_FADE_MS);
    expect(rain.volume).toBeCloseTo(0.5);
  });

  // Restarting the loop on every passage that shares a bed would be
  // audible as a seam each time the listener moves on.
  it('carries the same bed across passages without restarting it', () => {
    const { rerender } = render({ url: 'rain.mp3' });
    vi.advanceTimersByTime(AMBIENCE_FADE_MS);
    rerender({ url: 'rain.mp3' });
    expect(made).toHaveLength(1);
    expect(made[0].paused).toBe(false);
  });

  it('crossfades to a different bed', () => {
    const { rerender } = render({ url: 'rain.mp3' });
    vi.advanceTimersByTime(AMBIENCE_FADE_MS);
    rerender({ url: 'wind.mp3' });
    const [rain, wind] = made;

    vi.advanceTimersByTime(AMBIENCE_FADE_MS / 2);
    // Both sounding, one on the way down and one on the way up.
    expect(rain.paused).toBe(false);
    expect(rain.volume).toBeGreaterThan(0);
    expect(rain.volume).toBeLessThan(0.5);
    expect(wind.volume).toBeGreaterThan(0);
    expect(wind.volume).toBeLessThan(0.5);

    vi.advanceTimersByTime(AMBIENCE_FADE_MS / 2);
    expect(rain.paused).toBe(true);
    expect(rain.volume).toBe(0);
    expect(wind.volume).toBeCloseTo(0.5);
  });

  it('fades out and stops when a passage has no bed', () => {
    const { rerender } = render({ url: 'rain.mp3' });
    vi.advanceTimersByTime(AMBIENCE_FADE_MS);
    rerender({ url: null });
    vi.advanceTimersByTime(AMBIENCE_FADE_MS);
    expect(made[0].paused).toBe(true);
    expect(made[0].volume).toBe(0);
  });

  it('follows the volume slider, including mid-fade', () => {
    const { rerender } = render({ url: 'rain.mp3', volume: 0.5 });
    vi.advanceTimersByTime(AMBIENCE_FADE_MS / 2);
    rerender({ url: 'rain.mp3', volume: 0.2 });
    vi.advanceTimersByTime(AMBIENCE_FADE_MS);
    expect(made[0].volume).toBeCloseTo(0.2);

    rerender({ url: 'rain.mp3', volume: 0.8 });
    expect(made[0].volume).toBeCloseTo(0.8);
  });

  it('silences everything on unmount, including a bed still fading out', () => {
    const { rerender, unmount } = render({ url: 'rain.mp3' });
    vi.advanceTimersByTime(AMBIENCE_FADE_MS);
    rerender({ url: 'wind.mp3' });
    unmount();
    expect(made.every((el) => el.paused)).toBe(true);
  });

  // The file doesn't change across the passages that share a bed, so a
  // bed that failed to start once would otherwise stay silent for all
  // of them.
  it('retries a refused start, and stops retrying once the bed changes', async () => {
    let refusals = 2;
    const flaky = (url: string) => {
      const el = getElement(url) as unknown as FakeAudio;
      const play = el.play.bind(el);
      el.play = vi.fn(() =>
        refusals-- > 0 ? Promise.reject(new Error('NotAllowedError')) : play(),
      );
      return el as unknown as HTMLAudioElement;
    };
    const { rerender } = renderHook(
      (props: { url: string | null }) =>
        useAmbience({ url: props.url, volume: 0.5, getElement: flaky }),
      { initialProps: { url: 'rain.mp3' as string | null } },
    );
    const rain = made[0];
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rain.play).toHaveBeenCalledTimes(3);
    expect(rain.paused).toBe(false);

    refusals = 10;
    rerender({ url: 'wind.mp3' });
    const wind = made[1];
    await vi.advanceTimersByTimeAsync(1000);
    rerender({ url: null });
    await vi.advanceTimersByTimeAsync(10_000);
    // One retry before the bed moved on, none after.
    expect(wind.play).toHaveBeenCalledTimes(2);
  });

  it('survives play() being refused', () => {
    const refusing = (url: string) => {
      const el = getElement(url) as unknown as FakeAudio;
      el.play = () => Promise.reject(new Error('NotAllowedError'));
      return el as unknown as HTMLAudioElement;
    };
    expect(() =>
      renderHook(() => useAmbience({ url: 'rain.mp3', volume: 0.5, getElement: refusing })),
    ).not.toThrow();
  });
});
