import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App, { resolveNodeReference } from './App';

// `?start=<nodeId>` — open the player on a named passage instead of
// the beginning.
//
// The review loop this exists for: someone listening on headphones
// flags "incorrect audio" forty minutes into a story, and verifying the
// fix used to mean playing those forty minutes again. So fixes got
// verified by assumption, or not at all.

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

const STORY_ID = 'start-param-test';

/**
 * A story whose passages live inside a knot, so the knot-qualified and
 * suffix arms of the resolver have something to resolve against.
 */
function makeStory() {
  return {
    id: STORY_ID,
    title: 'Start Param Test',
    audioBaseUrl: './audio/',
    startNode: 'tell_you.opening',
    nodes: {
      'tell_you.opening': {
        id: 'tell_you.opening',
        type: 'stitch',
        content: [{ text: 'The beginning.' }],
        choices: [{ text: 'Onward', target: 'tell_you.middle' }],
        divert: null,
        tags: [],
      },
      'tell_you.middle': {
        id: 'tell_you.middle',
        type: 'stitch',
        content: [{ text: 'Forty minutes in.' }],
        choices: [{ text: 'Onward', target: 'tell_you.ending' }],
        divert: null,
        tags: [],
      },
      'tell_you.ending': {
        id: 'tell_you.ending',
        type: 'stitch',
        content: [{ text: 'The end.' }],
        choices: [],
        divert: null,
        tags: [],
      },
    },
  };
}

/** Point the jsdom URL at a preview link. */
function openWith(search: string) {
  window.history.replaceState({}, '', search ? `/?${search}` : '/');
}

function writeAutosave(nodeId: string, history: string[] = []) {
  localStorage.setItem(
    `wanderline_${STORY_ID}_slots`,
    JSON.stringify([
      {
        id: 'autosave',
        name: 'Autosave',
        nodeId,
        history,
        savedAt: '2026-08-27T10:00:00.000Z',
      },
    ]),
  );
}

// Fake timers, drained before cleanup: startStory arms a bare
// setTimeout(300) that nothing cancels, and with real timers it fires
// after teardown against jsdom's Audio (whose play() returns undefined),
// throwing an uncaught error that fails CI with every test passing.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.Audio = MockAudio as unknown as typeof Audio;
  localStorage.clear();
  sessionStorage.clear();
  openWith('');
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  cleanup();
  vi.useRealTimers();
  globalThis.Audio = originalAudio;
  openWith('');
  delete (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__;
  vi.restoreAllMocks();
});

async function renderAndStart() {
  (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
  render(<App />);
  fireEvent.click(await screen.findByLabelText('Start the story'));
}

describe('resolveNodeReference', () => {
  const nodes = { 'tell_you.opening': {}, 'tell_you.middle': {} };

  it('takes an exact node id as-is', () => {
    expect(resolveNodeReference('tell_you.middle', nodes, null)).toBe('tell_you.middle');
  });

  it('qualifies a bare stitch name with the context knot', () => {
    expect(resolveNodeReference('middle', nodes, 'tell_you.opening')).toBe('tell_you.middle');
  });

  it('falls back to a suffix match when there is no context', () => {
    expect(resolveNodeReference('middle', nodes, null)).toBe('tell_you.middle');
  });

  it('returns null for a reference nothing matches', () => {
    expect(resolveNodeReference('nowhere', nodes, 'tell_you.opening')).toBeNull();
  });

  // A story with a passage called "constructor" is unlikely but a
  // reference to one that ISN'T there must not resolve to something
  // inherited from Object.prototype.
  it('ignores keys inherited from Object.prototype', () => {
    expect(resolveNodeReference('constructor', nodes, null)).toBeNull();
  });
});

describe('?start= opens the player on a passage', () => {
  it('starts at an exact node id', async () => {
    openWith('start=tell_you.middle');
    await renderAndStart();
    expect(await screen.findByText('Forty minutes in.')).toBeTruthy();
  });

  // The shape an editor link takes when the author wrote a relative
  // divert and the compiler kept the bare stitch name.
  it('resolves a bare stitch name against the start node’s knot', async () => {
    openWith('start=ending');
    await renderAndStart();
    expect(await screen.findByText('The end.')).toBeTruthy();
  });

  it('says where it is about to start before playback begins', async () => {
    openWith('start=tell_you.middle');
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    await screen.findByLabelText('Start the story');
    expect(screen.getByText('Starting from passage tell_you.middle.')).toBeTruthy();
  });

  // A link outlives the passage it names: a rename or a re-upload and
  // the id is gone. Stranding the listener on a blank player would be
  // worse than the beginning, but silently playing the beginning while
  // they expect the middle is how a "fixed" take goes unverified.
  it('falls back to the beginning and says so when the passage is gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openWith('start=a_passage_that_left');
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    await screen.findByLabelText('Start the story');
    expect(
      screen.getByText('No passage matching "a_passage_that_left" — starting from the beginning.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Start the story'));
    expect(await screen.findByText('The beginning.')).toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });

  it('ignores an empty ?start=', async () => {
    openWith('start=');
    await renderAndStart();
    expect(await screen.findByText('The beginning.')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('?start= versus a saved autosave', () => {
  // The autosave is an inference about where you probably want to be.
  // `?start=` is somebody saying so — and anyone arriving on one has
  // just clicked "Preview from here" on a specific passage.
  it('wins over an autosave pointing somewhere else', async () => {
    writeAutosave('tell_you.ending');
    openWith('start=tell_you.middle');
    await renderAndStart();
    expect(await screen.findByText('Forty minutes in.')).toBeTruthy();
  });

  // Winning must not mean destroying: every slot is still offered on
  // the instructions screen, so resuming is one click away.
  it('still offers the autosave to resume from', async () => {
    writeAutosave('tell_you.ending');
    openWith('start=tell_you.middle');
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    await screen.findByLabelText('Start the story');
    const resume = screen.getByText('Autosave');
    fireEvent.click(resume);
    expect(await screen.findByText('The end.')).toBeTruthy();
  });

  // The pre-existing behaviour, which the new branch sits in front of.
  it('resumes the autosave when no ?start= is given', async () => {
    writeAutosave('tell_you.ending');
    await renderAndStart();
    expect(await screen.findByText('The end.')).toBeTruthy();
  });
});
