import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import App from './App';

// Playback-control coverage for four audio faults reported against a
// released build:
//
//   - Pausing and resuming with the on-screen button restarted the
//     passage, while the same pause/resume from headphones carried on
//     where it left off.
//   - A passage that buffered part way through replayed its opening
//     seconds instead of continuing.
//   - Restarting a node stacked a second looping choice sequence on top
//     of the first, so several clips sounded at once and a stale timer
//     could advance the story with no input.
//   - Background music stopped for good if its play() was ever rejected.
//
// All four share a cause: the work playVoiceover starts was only ever
// cancelled when the listener navigated to a DIFFERENT node, so
// re-entering the same node left the previous attempt running.

const audioInstances: MockAudio[] = [];

/**
 * When set, any element whose src matches has play() reject. Needed to
 * exercise the background-music retry, which only engages if the very
 * first play() the app issues is rejected.
 */
let failPlayFor: RegExp | null = null;

/**
 * Instrumented HTMLAudioElement stub.
 *
 * Mirrors the one in App.test.tsx but records every instance and every
 * play() call, which is what lets these tests see overlap and restarts
 * rather than just "something played".
 */
class MockAudio {
  src: string;
  preload = '';
  volume = 1;
  loop = false;
  paused = true;
  currentTime = 0;
  duration = 30;
  playCount = 0;
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
    this.playCount += 1;
    if (failPlayFor?.test(this.src)) return Promise.reject(new Error('NotAllowedError'));
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

/** The voiceover element for a node, newest first. */
function voiceoverFor(file: string): MockAudio | undefined {
  return [...audioInstances].reverse().find((a) => a.src.includes(file));
}

function makeStory(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-story',
    title: 'Test Story',
    audioBaseUrl: './audio/',
    startNode: 'start',
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [{ text: 'Welcome to the story.' }],
        choices: [{ text: 'Go on', target: 'next' }],
        divert: null,
        tags: [],
        audio: { voiceover: 'start.mp3' },
      },
      next: {
        id: 'next',
        type: 'knot',
        content: [{ text: 'The end.' }],
        choices: [],
        divert: null,
        tags: [],
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.Audio = MockAudio as unknown as typeof Audio;
  audioInstances.length = 0;
  failPlayFor = null;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  cleanup();
  vi.useRealTimers();
  globalThis.Audio = originalAudio;
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__;
});

async function startTheStory() {
  const startButton = await screen.findByLabelText('Start the story');
  fireEvent.click(startButton);
}

describe('play/pause resumes instead of restarting', () => {
  it('keeps the position when the on-screen button pauses and resumes', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    await startTheStory();

    // Autoplay kicks in a beat after the story starts; wait for the
    // button to offer Pause before touching the element, otherwise that
    // later playVoiceover rewinds whatever position we set.
    const pauseBtn = await screen.findByLabelText('Pause narration');
    const vo = voiceoverFor('start.mp3')!;
    expect(vo).toBeDefined();

    // Narration gets part way through.
    vo.currentTime = 12.5;
    vo.ontimeupdate?.();

    fireEvent.click(pauseBtn);
    expect(vo.paused).toBe(true);
    expect(vo.currentTime).toBe(12.5);

    const playBtn = await screen.findByLabelText('Play narration');
    fireEvent.click(playBtn);

    // The regression: the button used to call playVoiceover(), which
    // hands back a rewound element, so the listener heard the passage
    // from the top again.
    expect(vo.currentTime).toBe(12.5);
    expect(vo.paused).toBe(false);
  });

  // Deliberately asserts position rather than element identity or
  // instance count: playVoiceover hands back the SAME cached element it
  // just rewound, so neither of those can tell a resume from a restart.
  // Position is the only observable that distinguishes them.
  it('survives several pause/resume cycles without losing position', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    await startTheStory();

    await screen.findByLabelText('Pause narration');
    const vo = voiceoverFor('start.mp3')!;
    vo.currentTime = 20;
    vo.ontimeupdate?.();

    for (let i = 0; i < 3; i++) {
      fireEvent.click(await screen.findByLabelText('Pause narration'));
      expect(vo.currentTime).toBe(20);
      fireEvent.click(await screen.findByLabelText('Play narration'));
      expect(vo.currentTime).toBe(20);
    }
  });

  it('resumes the same way from the spacebar as from the button', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    await startTheStory();

    await screen.findByLabelText('Pause narration');
    const vo = voiceoverFor('start.mp3')!;

    vo.currentTime = 8;
    vo.ontimeupdate?.();

    fireEvent.keyDown(window, { key: ' ' });
    expect(vo.paused).toBe(true);
    fireEvent.keyDown(window, { key: ' ' });

    expect(vo.currentTime).toBe(8);
    expect(vo.paused).toBe(false);
  });
});

describe('restarting a node supersedes the previous attempt', () => {
  // The auto-navigate timer was the one thing playVoiceover never
  // cleared. Restart a node while a jump is already queued and the old
  // timer still fired, moving the listener on mid-passage with no input
  // (reported as the story advancing on its own).
  it('cancels a queued auto-navigate when the node restarts', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory({
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [{ text: 'Welcome to the story.' }],
          choices: [],
          divert: 'next',
          tags: [],
          audio: { voiceover: 'start.mp3' },
        },
        next: {
          id: 'next',
          type: 'knot',
          content: [{ text: 'The end.' }],
          choices: [],
          divert: null,
          tags: [],
        },
      },
    });
    render(<App />);
    await startTheStory();

    await screen.findByLabelText('Pause narration');
    const vo = voiceoverFor('start.mp3')!;

    // Narration finishes, which queues the jump to `next`.
    vo.paused = true;
    vo.onended?.();

    // The listener restarts the passage before that jump lands.
    fireEvent.click(await screen.findByLabelText('Play narration'));

    // Past when the queued jump would have fired.
    await vi.advanceTimersByTimeAsync(4000);

    expect(screen.queryByText(/The end\./)).toBeNull();
    expect(screen.getByText(/Welcome to the story\./)).toBeInTheDocument();
  });
});

describe('background music survives a rejected play', () => {
  it('retries rather than stopping for good', async () => {
    failPlayFor = /bgm\.mp3/;
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory({
      backgroundMusic: ['bgm.mp3'],
    });
    render(<App />);
    await startTheStory();

    const bgm = await waitFor(() => {
      const a = [...audioInstances].reverse().find((x) => x.src.includes('bgm.mp3'));
      expect(a).toBeDefined();
      return a!;
    });

    const afterFirstAttempt = bgm.playCount;
    await vi.advanceTimersByTimeAsync(10_000);

    // The bug was `play().catch(() => {})`: one rejection and the music
    // never came back, with no error and no ended event to chain from.
    expect(bgm.playCount).toBeGreaterThan(afterFirstAttempt + 1);
  });

  it('gives up after the retry cap instead of retrying forever', async () => {
    failPlayFor = /bgm\.mp3/;
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory({
      backgroundMusic: ['bgm.mp3'],
    });
    render(<App />);
    await startTheStory();

    const bgm = await waitFor(() => {
      const a = [...audioInstances].reverse().find((x) => x.src.includes('bgm.mp3'));
      expect(a).toBeDefined();
      return a!;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const settled = bgm.playCount;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(bgm.playCount).toBe(settled);
  });
});

// The author's chosen defaults were being applied twice: once when
// seeding the volume state from story.settings, then again when
// setting element.volume. A 30% music default played at 9%, a 50%
// indicator default at 25%. Voiceover escaped only because its default
// is 100 and 1 x 1 = 1, which is why this went unnoticed.
describe('author-chosen default volumes are applied exactly once', () => {
  // Two choices, because per-choice indicators only exist on a real
  // branch — the shared fixture's single-choice node never wires the
  // second cue up.
  function storyWithVolumes(settings: Record<string, unknown>) {
    const story = makeStory({
      backgroundMusic: ['bgm.mp3'],
      indicatorAudio: { choice1: 'c1.mp3', choice2: 'c2.mp3' },
      settings,
    }) as Record<string, unknown>;
    const nodes = story.nodes as Record<string, Record<string, unknown>>;
    nodes.start.choices = [
      { text: 'Go on', target: 'next' },
      { text: 'Turn back', target: 'next' },
    ];
    return story;
  }

  it('plays background music at the level the author set', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithVolumes({
      backgroundMusicVolume: 30,
    });
    render(<App />);
    await startTheStory();

    await waitFor(() => expect(audioInstances.some((a) => a.src.includes('bgm.mp3'))).toBe(true));
    const bgm = [...audioInstances].reverse().find((a) => a.src.includes('bgm.mp3'))!;
    expect(bgm.volume).toBeCloseTo(0.3, 5); // not 0.09
  });

  it('plays choice indicators at the level the author set', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithVolumes({
      indicatorVolume: 50,
    });
    render(<App />);
    await startTheStory();

    // Preloading also constructs an element for this file that never
    // plays and never gets a volume, so assert on the cue the player
    // actually wires up rather than on construction order.
    await waitFor(() => {
      const cues = audioInstances.filter((a) => a.src.includes('c1.mp3'));
      expect(cues.some((a) => Math.abs(a.volume - 0.5) < 1e-5)).toBe(true); // not 0.25
    });
  });

  it('plays voiceover at the level the author set', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithVolumes({
      voiceoverVolume: 60,
    });
    render(<App />);
    await startTheStory();

    const vo = voiceoverFor('start.mp3')!;
    await waitFor(() => expect(vo.volume).toBeCloseTo(0.6, 5));
  });

  // With no author setting the player falls back to its own defaults,
  // which have to match the editor's (VolumesTab: 100 / 30 / 50).
  it('falls back to the same music default the editor shows', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithVolumes({});
    render(<App />);
    await startTheStory();

    await waitFor(() => expect(audioInstances.some((a) => a.src.includes('bgm.mp3'))).toBe(true));
    const bgm = [...audioInstances].reverse().find((a) => a.src.includes('bgm.mp3'))!;
    expect(bgm.volume).toBeCloseTo(0.3, 5);
  });
});

// A per-device volume is a thing the LISTENER chose. Resolving the
// author's defaults into state used to write them to storage as
// though the listener had chosen them, so the author could never
// change their mind afterwards — and the editor, which reads the
// project settings directly, would go on showing a mix no returning
// listener could hear.
describe('per-device volumes record only what the listener chose', () => {
  const key = (id: string) => 'wanderline_' + id + '_volumes';

  function storyWithMusic(settings: Record<string, unknown>, id = 'test-story') {
    return makeStory({ id, backgroundMusic: ['bgm.mp3'], settings }) as Record<string, unknown>;
  }

  it('writes nothing on a first visit where the listener touched no slider', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({
      backgroundMusicVolume: 10,
    });
    render(<App />);
    await startTheStory();
    await waitFor(() => expect(audioInstances.some((a) => a.src.includes('bgm.mp3'))).toBe(true));

    expect(localStorage.getItem(key('test-story'))).toBeNull();
  });

  it('lets the author raise a default that a listener never overrode', async () => {
    // Visit one: the author's 10% is resolved and applied.
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({
      backgroundMusicVolume: 10,
    });
    const first = render(<App />);
    await startTheStory();
    await waitFor(() => expect(audioInstances.some((a) => a.src.includes('bgm.mp3'))).toBe(true));
    first.unmount();
    audioInstances.length = 0;

    // Visit two, after the author raised it. Storage must not be
    // shouting the old value back at us.
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({
      backgroundMusicVolume: 60,
    });
    render(<App />);
    await startTheStory();
    await waitFor(() => expect(audioInstances.some((a) => a.src.includes('bgm.mp3'))).toBe(true));
    const bgm = [...audioInstances].reverse().find((a) => a.src.includes('bgm.mp3'))!;
    expect(bgm.volume).toBeCloseTo(0.6, 5);
  });

  it("records the listener's own choice, under this story's key", async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({
      backgroundMusicVolume: 10,
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText(/Background music volume/), {
      target: { value: '80' },
    });

    const saved = JSON.parse(localStorage.getItem(key('test-story'))!);
    expect(saved.bgMusic).toBe(80);
  });

  // Writing all three channels would record the two the listener never
  // touched — their resolved author defaults — as preferences of their
  // own, and the author could never move those two again.
  it('records only the channel the listener moved', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({
      voiceoverVolume: 40,
      indicatorVolume: 50,
      backgroundMusicVolume: 30,
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText(/Background music volume/), {
      target: { value: '80' },
    });

    expect(JSON.parse(localStorage.getItem(key('test-story'))!)).toEqual({ bgMusic: 80 });
  });

  it('leaves the author free to move a volume the listener never touched', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({
      voiceoverVolume: 40,
    });
    const first = render(<App />);
    fireEvent.change(await screen.findByLabelText(/Background music volume/), {
      target: { value: '80' },
    });
    first.unmount();
    audioInstances.length = 0;

    // The author raises narration afterwards. The listener only ever
    // expressed an opinion about music.
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({
      voiceoverVolume: 90,
    });
    render(<App />);
    await startTheStory();

    const vo = voiceoverFor('start.mp3')!;
    await waitFor(() => expect(vo.volume).toBeCloseTo(0.9, 5));
  });

  // Keeps a listener's real preference across two moves of the same
  // slider, and across two different sliders.
  it('accumulates the choices a listener does make', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({});
    render(<App />);
    fireEvent.change(await screen.findByLabelText(/Background music volume/), {
      target: { value: '80' },
    });
    fireEvent.change(await screen.findByLabelText(/Narration volume/), {
      target: { value: '20' },
    });

    expect(JSON.parse(localStorage.getItem(key('test-story'))!)).toEqual({
      bgMusic: 80,
      voiceover: 20,
    });
  });

  // One global key meant previewing project A and then project B from
  // the editor handed B the volumes a listener had set for A. Driven
  // through the slider rather than a seeded key, so it holds whatever
  // key the implementation picks.
  it("does not hand one story's volumes to another", async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic(
      { backgroundMusicVolume: 30 },
      'story-a',
    );
    const first = render(<App />);
    fireEvent.change(await screen.findByLabelText(/Background music volume/), {
      target: { value: '5' },
    });
    first.unmount();
    audioInstances.length = 0;

    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic(
      { backgroundMusicVolume: 70 },
      'story-b',
    );
    render(<App />);
    await startTheStory();

    await waitFor(() => expect(audioInstances.some((a) => a.src.includes('bgm.mp3'))).toBe(true));
    const bgm = [...audioInstances].reverse().find((a) => a.src.includes('bgm.mp3'))!;
    expect(bgm.volume).toBeCloseTo(0.7, 5);
  });

  // The pre-1.8 blob recorded the author's RESOLVED defaults as though
  // the listener had chosen them, and nothing in it tells the two
  // apart. Honouring it would pin all three channels for every existing
  // listener and lock the author out — the fault this release removes,
  // preserved forever. It is cleared instead.
  it('ignores the old unscoped key rather than trusting what it holds', async () => {
    localStorage.setItem('wanderline_volumes', JSON.stringify({ bgMusic: 5 }));
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({
      backgroundMusicVolume: 70,
    });
    render(<App />);
    await startTheStory();

    await waitFor(() => expect(audioInstances.some((a) => a.src.includes('bgm.mp3'))).toBe(true));
    const bgm = [...audioInstances].reverse().find((a) => a.src.includes('bgm.mp3'))!;
    expect(bgm.volume).toBeCloseTo(0.7, 5);
  });

  it('clears the old key so nothing can resurrect it', async () => {
    localStorage.setItem('wanderline_volumes', JSON.stringify({ bgMusic: 5 }));
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWithMusic({});
    render(<App />);
    await startTheStory();

    await waitFor(() => expect(localStorage.getItem('wanderline_volumes')).toBeNull());
  });
});

// Choice cues and auto-advance interact: the cue branch runs first, so
// a single-choice passage that has a cue would loop it forever and
// never advance. It should play the cue once, then move on — while a
// real branch keeps offering its choices indefinitely.
describe('choice audio and auto-advance', () => {
  function storyWith(choices: { text: string; target: string }[], autoAdvance: boolean) {
    return makeStory({
      settings: { autoAdvance },
      indicatorAudio: { choice1: 'c1.mp3', choice2: 'c2.mp3' },
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [{ text: 'The beginning.' }],
          choices,
          divert: null,
          tags: [],
          audio: { voiceover: 'start.mp3', choice1: 'n1.mp3', choice2: 'n2.mp3' },
        },
        second: {
          id: 'second',
          type: 'knot',
          content: [{ text: 'The middle.' }],
          choices: [],
          divert: null,
          tags: [],
        },
      },
    });
  }

  // Asserts only that the cue is constructed and played, NOT that the
  // passage then advances — driving the full cue sequence needs an
  // 'ended' listener the mock doesn't implement. The advance itself is
  // covered by the autoAdvanceTarget unit tests.
  it('constructs and plays the choice cue', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWith(
      [{ text: 'On', target: 'second' }],
      true,
    );
    render(<App />);
    await startTheStory();
    const vo = voiceoverFor('start.mp3')!;
    await waitFor(() => expect(vo).toBeDefined());
    vo.onended?.();
    // The cue element gets constructed and played rather than skipped.
    await waitFor(() =>
      expect(audioInstances.some((a) => a.src.includes('c1.mp3') || a.src.includes('n1.mp3'))).toBe(
        true,
      ),
    );
  });

  // A real branch must keep waiting for the listener no matter what the
  // project setting says.
  it('never advances a passage with two choices', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWith(
      [
        { text: 'A', target: 'second' },
        { text: 'B', target: 'second' },
      ],
      true,
    );
    render(<App />);
    await startTheStory();
    const vo = voiceoverFor('start.mp3')!;
    await waitFor(() => expect(vo).toBeDefined());
    vo.onended?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(screen.getByText('The beginning.')).toBeTruthy();
    expect(screen.queryByText('The middle.')).toBeNull();
  });
});
