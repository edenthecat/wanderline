import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import App, { nodeText, readingFloorMs } from './App';

// A passage with no voiceover has no `audio.onended` to hold the
// listener on it, so auto-advance's timer was the whole story: a fixed
// 2-second default, however much there was to read. A reviewer of a
// published Wanderline story reported being swept past unvoiced
// passages "without audio, it would skip right through and you had to
// spam the back button a lot to read the whole passage" — exactly this.
//
// readingFloorMs raises that hold for a long passage; it must never
// shrink it below the existing 2-second default for a short one.

describe('readingFloorMs', () => {
  it('is zero for empty text', () => {
    expect(readingFloorMs('')).toBe(0);
    expect(readingFloorMs('   ')).toBe(0);
  });

  it('scales with word count at the fixed reading pace', () => {
    // 200 words per minute -> 300ms/word.
    expect(readingFloorMs('one two three four five six seven eight nine ten')).toBe(3000);
  });

  it('is well under the 2-second default for a short passage', () => {
    expect(readingFloorMs('Yes.')).toBeLessThan(2000);
  });
});

describe('nodeText', () => {
  it('prefers an explicit transcript over the Ink content', () => {
    expect(
      nodeText({
        content: [{ text: 'raw Ink prose' }],
        metadata: { transcript: 'the transcript' },
      }),
    ).toBe('the transcript');
  });

  it('joins content lines when there is no transcript', () => {
    expect(nodeText({ content: [{ text: 'One.' }, { text: 'Two.' }] })).toBe('One. Two.');
  });

  it('falls through an empty transcript to the content', () => {
    expect(nodeText({ content: [{ text: 'Content wins.' }], metadata: { transcript: '  ' } })).toBe(
      'Content wins.',
    );
  });
});

class MockAudio {
  src = '';
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

const LONG_PASSAGE =
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';

function story(startContent: string) {
  return {
    id: 'reading-floor',
    title: 'Reading floor',
    audioBaseUrl: './audio/',
    startNode: 'start',
    settings: { autoAdvance: true },
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [{ text: startContent }],
        choices: [],
        divert: 'end',
        tags: [],
        // No `audio` field: this is the voiceover-less path.
      },
      end: {
        id: 'end',
        type: 'knot',
        content: [{ text: 'The end.' }],
        choices: [],
        divert: null,
        tags: [],
      },
    },
  };
}

beforeEach(() => {
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

describe('auto-advance off a voiceover-less passage', () => {
  it('does not sweep past a long passage before there is time to read it', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = story(LONG_PASSAGE);
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    expect(await screen.findByText(LONG_PASSAGE)).toBeTruthy();

    // The old fixed 2-second default would have fired by now.
    await vi.advanceTimersByTimeAsync(2500);
    expect(screen.queryByText('The end.')).toBeNull();

    // readingFloorMs(LONG_PASSAGE) is 20 words * 300ms = 6000ms.
    await vi.advanceTimersByTimeAsync(4000);
    expect(await screen.findByText('The end.')).toBeTruthy();
  });

  it('still uses the 2-second default for a short passage', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = story('Yes.');
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    expect(await screen.findByText('Yes.')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(1900);
    expect(screen.queryByText('The end.')).toBeNull();

    await vi.advanceTimersByTimeAsync(200);
    expect(await screen.findByText('The end.')).toBeTruthy();
  });
});
