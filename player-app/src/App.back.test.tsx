import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import App from './App';

// goBack existed from the start but was reachable only by pressing
// Backspace or a headphone transport button. On a phone — the primary
// way these stories are listened to — there was no way back at all.

class MockAudio {
  src = '';
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
  }
  play() {
    this.playCount += 1;
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

/** `withAudio: false` gives a text-only passage. */
function makeStory(withAudio = true) {
  return {
    id: 'back-test',
    title: 'Back Test',
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
        ...(withAudio ? { audio: { voiceover: 'start.mp3' } } : {}),
      },
      second: {
        id: 'second',
        type: 'knot',
        content: [{ text: 'The middle.' }],
        choices: [],
        divert: null,
        tags: [],
        ...(withAudio ? { audio: { voiceover: 'second.mp3' } } : {}),
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.Audio = MockAudio as unknown as typeof Audio;
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

async function start(withAudio = true) {
  (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory(withAudio);
  render(<App />);
  fireEvent.click(await screen.findByLabelText('Start the story'));
}

const backLabel = 'Go back to the previous part';

describe('visible back control', () => {
  // A control that can never do anything is worse than no control.
  it('is hidden at the start of the story', async () => {
    await start();
    expect(screen.queryByLabelText(backLabel)).toBeNull();
  });

  it('appears once there is somewhere to go back to', async () => {
    await start();
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    expect(await screen.findByLabelText(backLabel)).toBeTruthy();
  });

  it('returns to the previous passage when pressed', async () => {
    await start();
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The middle.');
    fireEvent.click(await screen.findByLabelText(backLabel));
    expect(await screen.findByText('The beginning.')).toBeTruthy();
  });

  // The reason the control lives outside the audio-player condition:
  // a text-only passage used to have no way back.
  it('is available on a passage with no audio', async () => {
    await start(false);
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    expect(await screen.findByLabelText(backLabel)).toBeTruthy();
  });

  // Tapping the page advances the story; the control must not do both.
  it('does not also advance the story', async () => {
    await start();
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    fireEvent.click(await screen.findByLabelText(backLabel));
    await waitFor(() => expect(screen.getByText('The beginning.')).toBeTruthy());
    expect(screen.queryByText('The middle.')).toBeNull();
  });
});
