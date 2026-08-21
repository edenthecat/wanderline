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
