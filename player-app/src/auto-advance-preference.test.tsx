import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import App from './App';

// Auto-advance is a listener preference with an author-chosen default.
//
// The project setting decides where a listener's toggle starts. Once a
// listener sets it, their choice wins — including against the author
// changing that default later. Both sides default to off.
//
// The shape mirrors the volume settings, which had a fault worth not
// repeating: the player wrote its own initial state to localStorage
// before the story loaded, then read it back as a listener override,
// so the author's default could never win on a first visit.

const STORAGE_KEY = 'wanderline_test-story_autoAdvance';

class MockAudio {
  src: string;
  preload = '';
  volume = 1;
  loop = false;
  paused = true;
  currentTime = 0;
  duration = 0;
  oncanplaythrough: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onstalled: (() => void) | null = null;
  constructor(src?: string) {
    this.src = src || '';
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  addEventListener() {}
  removeEventListener() {}
}

function storyWith(settings: Record<string, unknown>) {
  return {
    id: 'test-story',
    title: 'Test Story',
    audioBaseUrl: './audio/',
    startNode: 'start',
    settings,
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [{ text: 'Welcome to the story.' }],
        // Two choices: a real decision, so nothing auto-advances while
        // these tests poke at the toggle.
        choices: [
          { text: 'Go left', target: 'left' },
          { text: 'Go right', target: 'left' },
        ],
        divert: null,
        tags: [],
        audio: { voiceover: 'start.mp3' },
      },
      left: {
        id: 'left',
        type: 'knot',
        content: [{ text: 'You went left.' }],
        choices: [],
        divert: 'END',
        tags: [],
      },
    },
  };
}

async function openSettings(settings: Record<string, unknown>) {
  (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = storyWith(settings);
  render(<App />);
  fireEvent.click(await screen.findByLabelText('Start the story'));
  fireEvent.click(await screen.findByLabelText('Settings'));
  return (await screen.findByLabelText('Advance automatically')) as HTMLInputElement;
}

beforeEach(() => {
  // Fake timers, drained before cleanup: startStory arms a bare
  // setTimeout(300) for the first voiceover that nothing cancels. On a
  // fast run the test finishes first, and the timer then fires after
  // unstubGlobals has restored jsdom's Audio — whose play() returns
  // undefined, so `.catch` throws an uncaught exception that fails the
  // run with every test still passing.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('Audio', MockAudio);
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__;
  vi.unstubAllGlobals();
});

describe('auto-advance preference', () => {
  it('is off when the author has not turned it on', async () => {
    expect((await openSettings({})).checked).toBe(false);
  });

  it('starts on when the author set it as the default', async () => {
    expect((await openSettings({ autoAdvance: true })).checked).toBe(true);
  });

  it('starts off when the author set it off explicitly', async () => {
    expect((await openSettings({ autoAdvance: false })).checked).toBe(false);
  });

  it("a listener's off beats the author's on", async () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    expect((await openSettings({ autoAdvance: true })).checked).toBe(false);
  });

  it("a listener's on beats the author's off", async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    expect((await openSettings({ autoAdvance: false })).checked).toBe(true);
  });

  it('remembers what the listener chose', async () => {
    const box = await openSettings({});
    fireEvent.click(box);
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('true'));
    expect(box.checked).toBe(true);
  });

  it('does not record a preference the listener never expressed', async () => {
    // The volumes bug: writing initial state before the story resolved
    // turned the component default into a stored override that beat the
    // author forever. Merely opening the panel must store nothing.
    await openSettings({ autoAdvance: true });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('keys storage per story', async () => {
    // A listener's choice on one story says nothing about another.
    localStorage.setItem('wanderline_other-story_autoAdvance', 'true');
    expect((await openSettings({})).checked).toBe(false);
  });
});
