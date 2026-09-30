import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import App from './App';
import { AMBIENCE_FADE_MS } from './useAmbience';

// Ambience and sound effects could be attached to a passage in the
// editor, and ambience even shipped in builds, but the player never
// started either: an audio designer had no way to hear their work in a
// preview or a build.

const audioInstances: MockAudio[] = [];

class MockAudio {
  src: string;
  preload = '';
  volume = 1;
  loop = false;
  paused = true;
  currentTime = 0;
  duration = 30;
  oncanplaythrough: (() => void) | null = null;
  oncanplay: (() => void) | null = null;
  onloadstart: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onstalled: (() => void) | null = null;
  onwaiting: (() => void) | null = null;
  error: unknown = null;

  constructor(src?: string) {
    this.src = src ?? '';
    audioInstances.push(this);
  }
  play(): Promise<void> {
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
  load() {
    setTimeout(() => this.oncanplaythrough?.(), 0);
  }
  addEventListener() {}
  removeEventListener() {}
}

const originalAudio = globalThis.Audio;

/** Every element for a file, oldest first. */
const elementsFor = (file: string) => audioInstances.filter((a) => a.src.includes(file));
const sounding = (file: string) => elementsFor(file).filter((a) => !a.paused);
const newest = (file: string) => elementsFor(file).at(-1);

function node(
  id: string,
  text: string,
  audio: Record<string, unknown> | undefined,
  choices: { text: string; target: string }[] = [],
) {
  return { id, type: 'knot', content: [{ text }], choices, divert: null, tags: [], audio };
}

// A passage with nowhere to go is an ending, and the bed stops at the
// end of the story, so single-passage tests give it somewhere to go.
const ON = [{ text: 'On', target: 'later' }];
const later = node('later', 'Later.', undefined);

function load(nodes: Record<string, unknown>) {
  (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = {
    id: 'ambience-test',
    title: 'Ambience Test',
    audioBaseUrl: './audio/',
    startNode: 'start',
    nodes,
  };
  render(<App />);
}

async function start() {
  fireEvent.click(await screen.findByLabelText('Start the story'));
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.Audio = MockAudio as unknown as typeof Audio;
  audioInstances.length = 0;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  cleanup();
  vi.useRealTimers();
  globalThis.Audio = originalAudio;
  delete (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__;
});

describe('preloading', () => {
  // The first passage is chosen during story load, not through
  // navigateToNode, so its bed and effects have to be in the startup
  // preload or they start late against already-loaded narration.
  it('fetches the first passage’s bed and effects before the story starts', async () => {
    load({
      start: node(
        'start',
        'The beginning.',
        {
          ambience: 'rain.mp3',
          sfx: [{ file: 'door.mp3' }],
        },
        ON,
      ),
      later,
    });
    await screen.findByLabelText('Start the story');
    await wait(50);
    expect(elementsFor('rain.mp3').length).toBeGreaterThan(0);
    expect(elementsFor('door.mp3').length).toBeGreaterThan(0);
  });
});

describe('ambience', () => {
  it('stays quiet on the instructions screen and starts with the story', async () => {
    load({ start: node('start', 'The beginning.', { ambience: 'rain.mp3' }, ON), later });
    await screen.findByLabelText('Start the story');
    expect(sounding('rain.mp3')).toHaveLength(0);

    await start();
    await wait(AMBIENCE_FADE_MS);
    const rain = sounding('rain.mp3');
    expect(rain).toHaveLength(1);
    expect(rain[0].loop).toBe(true);
    // The author/listener default level, reached after the fade-in.
    expect(rain[0].volume).toBeCloseTo(0.5);
  });

  it('carries one bed across passages that share it', async () => {
    load({
      start: node('start', 'The beginning.', { ambience: 'rain.mp3' }, [
        { text: 'On', target: 'second' },
      ]),
      second: node('second', 'The middle.', { ambience: 'rain.mp3' }, ON),
      later,
    });
    await start();
    await wait(AMBIENCE_FADE_MS);
    const before = newest('rain.mp3');

    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The middle.');
    await wait(AMBIENCE_FADE_MS);
    expect(sounding('rain.mp3')).toEqual([before]);
  });

  it('crossfades into the next passage’s bed, and out on a passage with none', async () => {
    load({
      start: node('start', 'The beginning.', { ambience: 'rain.mp3' }, [
        { text: 'On', target: 'second' },
      ]),
      second: node('second', 'The middle.', { ambience: 'wind.mp3' }, [
        { text: 'On', target: 'third' },
      ]),
      third: node('third', 'The end.', undefined),
    });
    await start();
    await wait(AMBIENCE_FADE_MS);

    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The middle.');
    await wait(AMBIENCE_FADE_MS + 100);
    expect(sounding('rain.mp3')).toHaveLength(0);
    expect(sounding('wind.mp3')).toHaveLength(1);

    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The end.');
    await wait(AMBIENCE_FADE_MS + 100);
    expect(sounding('wind.mp3')).toHaveLength(0);
  });

  it('follows the listener’s ambience slider', async () => {
    load({ start: node('start', 'The beginning.', { ambience: 'rain.mp3' }, ON), later });
    fireEvent.change(await screen.findByLabelText(/^Ambience and sound effects volume/), {
      target: { value: '20' },
    });
    await start();
    await wait(AMBIENCE_FADE_MS);
    expect(newest('rain.mp3')!.volume).toBeCloseTo(0.2);
  });

  it('starts at the author’s default level', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = {
      id: 'ambience-test',
      title: 'Ambience Test',
      audioBaseUrl: './audio/',
      startNode: 'start',
      settings: { ambienceVolume: 80 },
      nodes: { start: node('start', 'The beginning.', { ambience: 'rain.mp3' }, ON), later },
    };
    render(<App />);
    await start();
    await wait(AMBIENCE_FADE_MS);
    expect(newest('rain.mp3')!.volume).toBeCloseTo(0.8);
  });
});

describe('ambience at the end of the story', () => {
  // With auto-advance off (the default) nothing moves on from an ending
  // passage, so the bed has to stop on its own or it loops under
  // "The End" for as long as the page is open.
  it('keeps the bed under the final narration, then fades it out', async () => {
    load({
      start: node('start', 'The beginning.', { voiceover: 'end.mp3', ambience: 'rain.mp3' }),
    });
    await start();
    await screen.findByLabelText('Pause narration');
    await wait(AMBIENCE_FADE_MS);
    expect(sounding('rain.mp3')).toHaveLength(1);

    act(() => newest('end.mp3')!.onended?.());
    await wait(AMBIENCE_FADE_MS + 100);
    expect(sounding('rain.mp3')).toHaveLength(0);
  });

  it('stops on a final passage with no narration', async () => {
    load({
      start: node('start', 'The beginning.', { ambience: 'rain.mp3' }, [
        { text: 'On', target: 'last' },
      ]),
      last: node('last', 'The last words.', { ambience: 'rain.mp3' }),
    });
    await start();
    await wait(AMBIENCE_FADE_MS);
    expect(sounding('rain.mp3')).toHaveLength(1);
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The last words.');
    await wait(AMBIENCE_FADE_MS + 100);
    expect(sounding('rain.mp3')).toHaveLength(0);
  });
});

describe('ambience after an ending is left behind', () => {
  // A choice that leads to END leaves the passage's other choices on
  // screen. Picking one of those is a story in progress again.
  it('comes back when the listener picks another way on', async () => {
    load({
      start: node('start', 'The beginning.', { ambience: 'rain.mp3' }, [
        { text: 'Leave', target: 'END' },
        { text: 'Stay', target: 'stay' },
      ]),
      stay: node('stay', 'You stay.', { ambience: 'rain.mp3' }, ON),
      later,
    });
    await start();
    await wait(AMBIENCE_FADE_MS);
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await wait(AMBIENCE_FADE_MS + 100);
    expect(sounding('rain.mp3')).toHaveLength(0);

    fireEvent.click(await screen.findByLabelText(/^Choice 2/));
    await screen.findByText('You stay.');
    await wait(AMBIENCE_FADE_MS);
    expect(sounding('rain.mp3')).toHaveLength(1);
  });

  it('comes back when r restarts from the end screen', async () => {
    load({
      start: node('start', 'The beginning.', { ambience: 'rain.mp3' }, [
        { text: 'Leave', target: 'END' },
      ]),
    });
    await start();
    await wait(AMBIENCE_FADE_MS);
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await wait(AMBIENCE_FADE_MS + 100);
    expect(sounding('rain.mp3')).toHaveLength(0);

    fireEvent.keyDown(window, { key: 'r' });
    await wait(AMBIENCE_FADE_MS);
    expect(sounding('rain.mp3')).toHaveLength(1);
  });
});

describe('sound effects', () => {
  it('on a narrated passage: plays unset ones as it starts and timed ones on the narration’s clock', async () => {
    load({
      start: node('start', 'The beginning.', {
        voiceover: 'start.mp3',
        sfx: [{ file: 'door.mp3' }, { file: 'bell.mp3', offsetMs: 2000 }],
      }),
    });
    await start();
    await screen.findByLabelText('Pause narration');
    expect(sounding('door.mp3')).toHaveLength(1);
    expect(elementsFor('bell.mp3').filter((a) => !a.paused)).toHaveLength(0);

    const vo = newest('start.mp3')!;
    vo.currentTime = 1.5;
    act(() => vo.ontimeupdate?.());
    expect(sounding('bell.mp3')).toHaveLength(0);

    vo.currentTime = 2.1;
    act(() => vo.ontimeupdate?.());
    expect(sounding('bell.mp3')).toHaveLength(1);

    // Once per visit, not on every later timeupdate.
    vo.currentTime = 2.4;
    act(() => vo.ontimeupdate?.());
    expect(elementsFor('bell.mp3').filter((a) => !a.paused)).toHaveLength(1);
  });

  // "No timing" means as the passage starts, not when its narration does:
  // a pre-roll delay mustn't hold it back. An explicit 0 is on the
  // narration's clock, so it waits for the words.
  it('play untimed ones as the passage starts, even before a pre-roll ends', async () => {
    load({
      start: {
        ...node(
          'start',
          'The beginning.',
          {
            voiceover: 'start.mp3',
            sfx: [{ file: 'door.mp3' }, { file: 'bell.mp3', offsetMs: 0 }],
          },
          ON,
        ),
        metadata: { delayBeforeMs: 3000 },
      },
      later,
    });
    await start();
    await wait(500);
    const vo = newest('start.mp3');
    expect(vo?.paused ?? true).toBe(true);
    expect(sounding('door.mp3')).toHaveLength(1);
    expect(sounding('bell.mp3')).toHaveLength(0);
    await wait(3000);
    expect(sounding('bell.mp3')).toHaveLength(1);
  });

  // Play pressed while the pre-roll runs starts the narration afresh, but
  // mustn't restart an effect that's already sounding for this visit.
  it('don’t restart when play is pressed during a pre-roll', async () => {
    load({
      start: {
        ...node(
          'start',
          'The beginning.',
          { voiceover: 'start.mp3', sfx: [{ file: 'door.mp3' }] },
          ON,
        ),
        metadata: { delayBeforeMs: 3000 },
      },
      later,
    });
    await start();
    await wait(500);
    const door = elementsFor('door.mp3').filter((a) => !a.paused);
    expect(door).toHaveLength(1);
    // Part way through; a restart would rewind it (the cache hands the
    // same element back, rewound).
    door[0].currentTime = 0.8;
    const pause = vi.spyOn(door[0], 'pause');
    fireEvent.keyDown(window, { key: ' ' });
    await wait(100);
    expect(pause).not.toHaveBeenCalled();
    expect(door[0].currentTime).toBe(0.8);
    expect(door[0].paused).toBe(false);
  });

  // Going back leaves the narration waiting for play; the passage has
  // still started, so its untimed effects play.
  it('play untimed ones on arrival even when the narration waits for play', async () => {
    load({
      start: node(
        'start',
        'The beginning.',
        { voiceover: 'start.mp3', sfx: [{ file: 'door.mp3' }] },
        [{ text: 'On', target: 'second' }],
      ),
      second: node('second', 'The middle.', { voiceover: 'second.mp3' }, ON),
      later,
    });
    await start();
    await screen.findByLabelText('Pause narration');
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The middle.');
    await wait(500);
    expect(sounding('door.mp3')).toHaveLength(0);

    fireEvent.click(await screen.findByLabelText('Go back to the previous part'));
    await screen.findByText('The beginning.');
    await wait(50);
    expect(screen.getByLabelText('Play narration')).toBeTruthy();
    expect(sounding('door.mp3')).toHaveLength(1);
  });

  it('on a passage with no narration: counts from arriving', async () => {
    load({
      start: node('start', 'The beginning.', {
        sfx: [{ file: 'door.mp3' }, { file: 'bell.mp3', offsetMs: 1500 }],
      }),
    });
    await start();
    await screen.findByText('The beginning.');
    await wait(50);
    expect(sounding('door.mp3')).toHaveLength(1);
    expect(sounding('bell.mp3')).toHaveLength(0);
    await wait(1500);
    expect(sounding('bell.mp3')).toHaveLength(1);
  });

  // Restarting on the same passage is a new visit even though the node
  // doesn't change.
  it('replay on a silent passage after the r shortcut restarts it', async () => {
    load({
      start: node('start', 'The beginning.', { sfx: [{ file: 'door.mp3' }] }, ON),
      later,
    });
    await start();
    await screen.findByText('The beginning.');
    await wait(50);
    expect(elementsFor('door.mp3').filter((a) => !a.paused)).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'r' });
    await wait(50);
    // The first visit's copy was stopped by the restart; this is the
    // replay.
    expect(sounding('door.mp3')).toHaveLength(1);
  });

  // Coming back online recovers the same visit: the narration resumes
  // where it stalled, and effects already heard don't play again.
  it('aren’t replayed when playback recovers from a dropped connection', async () => {
    load({
      start: node(
        'start',
        'The beginning.',
        { voiceover: 'start.mp3', sfx: [{ file: 'door.mp3' }] },
        ON,
      ),
      later,
    });
    await start();
    await screen.findByLabelText('Pause narration');
    expect(elementsFor('door.mp3').filter((a) => !a.paused)).toHaveLength(1);
    const played = elementsFor('door.mp3').length;

    const vo = newest('start.mp3')!;
    vo.currentTime = 12;
    act(() => vo.ontimeupdate?.());
    act(() => vo.onwaiting?.());
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await wait(500);
    // Resumed, not restarted, and the door didn't slam twice.
    expect(newest('start.mp3')!.currentTime).toBe(12);
    expect(elementsFor('door.mp3')).toHaveLength(played);
  });

  it('play one timed past the end of the narration when it ends', async () => {
    load({
      start: node(
        'start',
        'The beginning.',
        { voiceover: 'start.mp3', sfx: [{ file: 'bell.mp3', offsetMs: 60_000 }] },
        ON,
      ),
      later,
    });
    await start();
    await screen.findByLabelText('Pause narration');
    expect(sounding('bell.mp3')).toHaveLength(0);
    act(() => newest('start.mp3')!.onended?.());
    expect(sounding('bell.mp3')).toHaveLength(1);
  });

  // Time on the passage before Help opened counts toward an effect's
  // delay; closing Help only waits out what's left of it.
  it('on a passage with no narration: resume their countdown after Help', async () => {
    load({
      start: node('start', 'The beginning.', { sfx: [{ file: 'bell.mp3', offsetMs: 10_000 }] }, ON),
      later,
    });
    await start();
    await screen.findByText('The beginning.');
    await wait(9000);
    expect(sounding('bell.mp3')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Help and instructions'));
    await wait(5000);
    expect(sounding('bell.mp3')).toHaveLength(0);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    await wait(1500);
    expect(sounding('bell.mp3')).toHaveLength(1);
  });

  it('stop when the listener moves on, and a pending one never fires', async () => {
    load({
      start: node(
        'start',
        'The beginning.',
        { sfx: [{ file: 'door.mp3' }, { file: 'bell.mp3', offsetMs: 3000 }] },
        [{ text: 'On', target: 'second' }],
      ),
      second: node('second', 'The middle.', undefined),
    });
    await start();
    await screen.findByText('The beginning.');
    await wait(50);
    const door = newest('door.mp3')!;
    expect(door.paused).toBe(false);

    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The middle.');
    expect(door.paused).toBe(true);
    await wait(4000);
    expect(sounding('bell.mp3')).toHaveLength(0);
  });

  it('play at the ambience level', async () => {
    load({
      start: node('start', 'The beginning.', { sfx: [{ file: 'door.mp3' }] }),
    });
    fireEvent.change(await screen.findByLabelText(/^Ambience and sound effects volume/), {
      target: { value: '30' },
    });
    await start();
    await wait(50);
    expect(newest('door.mp3')!.volume).toBeCloseTo(0.3);
  });
});
