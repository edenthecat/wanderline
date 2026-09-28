import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import App from './App';

// MediaSession position state is page-level: whatever App last handed
// it stays on the lock screen and AirPods transport until something
// overwrites it. Progress has to follow the passage it was measured on
// through every way the node can change, not just navigateToNode, or
// the OS reports the previous passage's position against the new one.

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
const setPositionState = vi.fn();

function voiceoverFor(file: string): MockAudio | undefined {
  return [...audioInstances].reverse().find((a) => a.src.includes(file));
}

// By default `start` has no voiceover, so nothing on it ever reports a
// duration of its own: a stale position survives there unless App
// clears it. `startVoiceover` gives it one, for re-entering the same
// node (restart on the start node) where the node id never changes.
function makeStory({ startVoiceover = false } = {}) {
  return {
    id: 'position-test',
    title: 'Position Test',
    audioBaseUrl: './audio/',
    startNode: 'start',
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [{ text: 'The beginning.' }],
        choices: [{ text: 'Onward', target: 'second' }],
        divert: null,
        tags: [],
        ...(startVoiceover ? { audio: { voiceover: 'start.mp3' } } : {}),
      },
      second: {
        id: 'second',
        type: 'knot',
        content: [{ text: 'The middle.' }],
        choices: [],
        divert: null,
        tags: [],
        audio: { voiceover: 'second.mp3' },
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.Audio = MockAudio as unknown as typeof Audio;
  audioInstances.length = 0;
  setPositionState.mockClear();
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null,
      playbackState: 'none',
      setActionHandler: () => {},
      setPositionState,
    },
  });
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  cleanup();
  vi.useRealTimers();
  globalThis.Audio = originalAudio;
  vi.restoreAllMocks();
  delete (navigator as unknown as Record<string, unknown>).mediaSession;
  delete (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__;
});

/** Start the story, move to `second`, and let its narration get 12.5s in. */
async function playPartWayIntoSecond(): Promise<MockAudio> {
  (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
  render(<App />);
  fireEvent.click(await screen.findByLabelText('Start the story'));
  fireEvent.click(await screen.findByLabelText(/^Choice 1/));
  await screen.findByLabelText('Pause narration');
  const vo = voiceoverFor('second.mp3')!;
  expect(vo).toBeDefined();
  vo.currentTime = 12.5;
  act(() => vo.ontimeupdate?.());
  expect(setPositionState).toHaveBeenLastCalledWith({
    duration: 30,
    playbackRate: 1,
    position: 12.5,
  });
  return vo;
}

describe('MediaSession position state across node changes', () => {
  // goBack never reset progress, so returning to a passage with no
  // voiceover kept publishing the one just left.
  it('clears the position when going back to a passage with no voiceover', async () => {
    await playPartWayIntoSecond();
    fireEvent.click(await screen.findByLabelText('Go back to the previous part'));
    await screen.findByText('The beginning.');
    await waitFor(() => expect(setPositionState).toHaveBeenLastCalledWith());
  });

  // A timeupdate already queued on the element being left can fire
  // after the node changed; it must not repopulate the old position.
  it('ignores a late timeupdate from the passage just left', async () => {
    const vo = await playPartWayIntoSecond();
    fireEvent.click(await screen.findByLabelText('Go back to the previous part'));
    await screen.findByText('The beginning.');
    await waitFor(() => expect(setPositionState).toHaveBeenLastCalledWith());

    vo.currentTime = 20;
    act(() => vo.ontimeupdate?.());
    expect(setPositionState).toHaveBeenLastCalledWith();
    expect(setPositionState).not.toHaveBeenCalledWith(expect.objectContaining({ position: 20 }));
  });
});

describe('MediaSession position state when re-entering the same node', () => {
  async function playPartWayIntoStart(): Promise<MockAudio> {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory({
      startVoiceover: true,
    });
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    await screen.findByLabelText('Pause narration');
    const vo = voiceoverFor('start.mp3')!;
    expect(vo).toBeDefined();
    vo.currentTime = 12.5;
    act(() => vo.ontimeupdate?.());
    expect(setPositionState).toHaveBeenLastCalledWith({
      duration: 30,
      playbackRate: 1,
      position: 12.5,
    });
    return vo;
  }

  // Restarting while already on the start node leaves currentNodeId
  // unchanged, so a reset keyed only on the id never fires.
  it('clears the position when restarting from the start node', async () => {
    // Starting the story writes an autosave, which makes restart ask first.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const vo = await playPartWayIntoStart();
    fireEvent.click(screen.getByLabelText('Restart story from beginning'));
    await waitFor(() => expect(setPositionState).toHaveBeenLastCalledWith());

    // The paused element's queued timeupdate must not bring it back.
    vo.currentTime = 12.75;
    act(() => vo.ontimeupdate?.());
    expect(setPositionState).toHaveBeenLastCalledWith();
  });

  it('clears the position when the r shortcut restarts from the start node', async () => {
    const vo = await playPartWayIntoStart();
    fireEvent.keyDown(window, { key: 'r' });
    await waitFor(() => expect(setPositionState).toHaveBeenLastCalledWith());

    vo.currentTime = 12.75;
    act(() => vo.ontimeupdate?.());
    expect(setPositionState).toHaveBeenLastCalledWith();
  });
});
