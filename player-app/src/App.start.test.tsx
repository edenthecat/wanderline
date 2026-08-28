import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import App, { resolveNodeReference, resolveSessionStart } from './App';

// `?start=<nodeId>` — open the player on a named passage instead of
// the beginning.
//
// The review loop this exists for: someone listening on headphones
// flags "incorrect audio" forty minutes into a story, and verifying the
// fix used to mean playing those forty minutes again. So fixes got
// verified by assumption, or not at all.

/** Every element the player built, in creation order. */
const audioInstances: MockAudio[] = [];

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
    audioInstances.push(this);
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
      // A divert written as a bare stitch name — the shape a relative
      // divert (`-> .ending`) takes once the Ink compiler is done with
      // it, and the reason references need resolving at all.
      'tell_you.hallway': {
        id: 'tell_you.hallway',
        type: 'stitch',
        content: [{ text: 'A hallway.' }],
        choices: [],
        divert: 'ending',
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

function readAutosave(): { nodeId: string } | undefined {
  const raw = localStorage.getItem(`wanderline_${STORY_ID}_slots`);
  if (!raw) return undefined;
  return (JSON.parse(raw) as { id: string; nodeId: string }[]).find((s) => s.id === 'autosave');
}

// Fake timers, drained before cleanup: startStory arms a bare
// setTimeout(300) that nothing cancels, and with real timers it fires
// after teardown against jsdom's Audio (whose play() returns undefined),
// throwing an uncaught error that fails CI with every test passing.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.Audio = MockAudio as unknown as typeof Audio;
  audioInstances.length = 0;
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

describe('resolveSessionStart', () => {
  const story = makeStory();
  const slot = (nodeId: string, id = 'autosave', history: string[] = []) => ({
    id,
    nodeId,
    history,
  });
  const saved = [slot('tell_you.ending', 'autosave', ['tell_you.opening'])];
  const none = { start: null, fresh: false };

  it('takes a resolved ?start= over the autosave', () => {
    const s = resolveSessionStart(story, saved, { start: 'tell_you.middle', fresh: false });
    expect(s.nodeId).toBe('tell_you.middle');
    expect(s.history).toEqual([]);
    expect(s.protectSaves).toBe(true);
  });

  // The notice on screen says "starting from the beginning". Falling
  // back to the autosave here would make that a lie, and would drop
  // the listener somewhere they never asked for.
  it('begins at the story start when ?start= matched nothing, autosave or not', () => {
    const s = resolveSessionStart(story, saved, { start: 'gone', fresh: false });
    expect(s.nodeId).toBe(story.startNode);
    expect(s.resolved).toBeNull();
    expect(s.requested).toBe('gone');
    expect(s.protectSaves).toBe(true);
  });

  it('honours ?fresh=1 over the autosave', () => {
    const s = resolveSessionStart(story, saved, { start: null, fresh: true });
    expect(s.nodeId).toBe(story.startNode);
    expect(s.protectSaves).toBe(true);
  });

  it('resumes the autosave when the URL asks for nothing', () => {
    const s = resolveSessionStart(story, saved, none);
    expect(s.nodeId).toBe('tell_you.ending');
    expect(s.history).toEqual(['tell_you.opening']);
    expect(s.protectSaves).toBe(false);
  });

  // Otherwise a brand-new story the listener has only just opened
  // would surface a "Resume?" affordance pointing at its own start.
  it('ignores an autosave that sits on the start node', () => {
    const s = resolveSessionStart(story, [slot(story.startNode)], none);
    expect(s.nodeId).toBe(story.startNode);
  });

  it('begins at the start node with no saves and no parameters', () => {
    const s = resolveSessionStart(story, [], none);
    expect(s.nodeId).toBe(story.startNode);
    expect(s.protectSaves).toBe(false);
  });

  // A jump is never a run, even on a device with nothing saved: a
  // jumped-in position silently becoming "where you were" would leave
  // the next plain preview opening in the middle of the story.
  it('never records a session that jumped in', () => {
    const s = resolveSessionStart(story, [], { start: 'tell_you.middle', fresh: false });
    expect(s.nodeId).toBe('tell_you.middle');
    expect(s.protectSaves).toBe(true);
  });

  // Starting at the beginning and playing forward IS a listen, and
  // refusing to record it would protect nothing.
  it('records a ?fresh=1 run on a device with no saves', () => {
    const s = resolveSessionStart(story, [], { start: null, fresh: true });
    expect(s.nodeId).toBe(story.startNode);
    expect(s.protectSaves).toBe(false);
  });

  // A stale link leaves the listener at the beginning, same as above.
  it('records when ?start= matched nothing and there are no saves', () => {
    const s = resolveSessionStart(story, [], { start: 'gone', fresh: false });
    expect(s.protectSaves).toBe(false);
  });

  // Restart wipes manual slots too, so "is there saved state here?" is
  // the question — not "is there an autosave?".
  it('protects manual slots even with no autosave', () => {
    const s = resolveSessionStart(story, [slot('tell_you.ending', 'manual-1')], {
      start: 'tell_you.middle',
      fresh: false,
    });
    expect(s.protectSaves).toBe(true);
    // A manual slot is not resumed automatically — the picker offers it.
    expect(s.nodeId).toBe('tell_you.middle');
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

  // A stale link — the passage was renamed, or the story re-uploaded.
  // Resuming the save here would contradict the notice on screen.
  it('begins at the beginning, not the save, when the passage is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeAutosave('tell_you.ending');
    openWith('start=a_passage_that_left');
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    await screen.findByLabelText('Start the story');
    expect(
      screen.getByText('No passage matching "a_passage_that_left" — starting from the beginning.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Start the story'));
    expect(await screen.findByText('The beginning.')).toBeTruthy();
  });
});

// Hearing one passage to check a fix is not progress. Recording it
// over the listener's real position destroys something they cannot get
// back — and a "Preview from here" link is exactly the kind of thing
// that gets shared to someone mid-story.
describe('a review session leaves no trace', () => {
  // The save deliberately names a passage the jump never visits, so a
  // write that happened to land on the same id can't pass for a save
  // that was left alone.
  it('does not overwrite the autosave when navigating from a ?start= jump', async () => {
    writeAutosave('tell_you.hallway', ['tell_you.opening']);
    openWith('start=tell_you.middle');
    await renderAndStart();
    await screen.findByText('Forty minutes in.');
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The end.');
    expect(readAutosave()?.nodeId).toBe('tell_you.hallway');
  });

  it('does not overwrite the autosave in a ?fresh=1 session', async () => {
    writeAutosave('tell_you.hallway', ['tell_you.opening']);
    openWith('fresh=1');
    await renderAndStart();
    await screen.findByText('The beginning.');
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('Forty minutes in.');
    expect(readAutosave()?.nodeId).toBe('tell_you.hallway');
  });

  // The pre-existing contract for an ordinary listen.
  it('still records progress when the URL asks for nothing', async () => {
    await renderAndStart();
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('Forty minutes in.');
    expect(readAutosave()?.nodeId).toBe('tell_you.middle');
  });

  // Restart wipes every slot for the story — autosave and manual saves
  // alike, with no confirmation. That is a clean slate for a listener
  // restarting THEIR run, and someone else's data for a reviewer who
  // followed a link into it.
  it('does not wipe the saves when Restart is pressed in a review session', async () => {
    writeAutosave('tell_you.hallway', ['tell_you.opening']);
    openWith('start=tell_you.middle');
    await renderAndStart();
    await screen.findByText('Forty minutes in.');
    fireEvent.click(screen.getByLabelText('Restart story from beginning'));
    await screen.findByText('The beginning.');
    expect(readAutosave()?.nodeId).toBe('tell_you.hallway');
  });

  // The pre-existing contract for an ordinary listen: Restart means a
  // clean slate.
  it('still wipes the saves when Restart is pressed in an ordinary listen', async () => {
    writeAutosave('tell_you.middle', []);
    await renderAndStart();
    await screen.findByText('Forty minutes in.');
    fireEvent.click(screen.getByLabelText('Restart story from beginning'));
    await screen.findByText('The beginning.');
    expect(readAutosave()).toBeUndefined();
  });

  // Even with nothing to protect: the position reached from a jump is
  // not this listener's progress, and recording it would open the next
  // plain preview in the middle of the story.
  it('records nothing on a ?start= link into a story with no saves', async () => {
    openWith('start=tell_you.middle');
    await renderAndStart();
    await screen.findByText('Forty minutes in.');
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The end.');
    expect(readAutosave()).toBeUndefined();
  });

  // A ?fresh=1 run on a clean device starts at the beginning and plays
  // forward, which is an ordinary listen.
  it('records a ?fresh=1 run on a device with no saves', async () => {
    openWith('fresh=1');
    await renderAndStart();
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('Forty minutes in.');
    expect(readAutosave()?.nodeId).toBe('tell_you.middle');
  });

  // Picking a save is the listener saying "this is my run".
  it('records again once a save is loaded from the picker', async () => {
    writeAutosave('tell_you.middle', []);
    openWith('fresh=1');
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    await screen.findByLabelText('Start the story');
    fireEvent.click(screen.getByText('Autosave'));
    await screen.findByText('Forty minutes in.');
    fireEvent.click(await screen.findByLabelText(/^Choice 1/));
    await screen.findByText('The end.');
    expect(readAutosave()?.nodeId).toBe('tell_you.ending');
  });
});

// One resolver for every way forward. The keyboard used to demand an
// exact node id, so a bare-stitch divert auto-advanced fine and did
// nothing at all when the listener pressed Enter.
describe('following a bare-stitch divert', () => {
  it('moves on when Enter is pressed', async () => {
    openWith('start=tell_you.hallway');
    await renderAndStart();
    await screen.findByText('A hallway.');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(await screen.findByText('The end.')).toBeTruthy();
  });
});

// The reviewer waits through "Preparing...", presses Start, and the
// one file they came for is the one that wasn't warmed — a network
// fetch and the stall banner on the passage being checked.
describe('preloading a pinned session', () => {
  /** A chain four passages deep, so the tail sits outside the two
   * levels the critical preload sweep covers. */
  function makeDeepStory() {
    const link = (id: string, next: string | null) => ({
      id,
      type: 'stitch',
      content: [{ text: id }],
      choices: next ? [{ text: 'Onward', target: next }] : [],
      divert: null,
      tags: [],
      audio: { voiceover: `${id.split('.')[1]}.mp3` },
    });
    return {
      id: STORY_ID,
      title: 'Deep',
      audioBaseUrl: './audio/',
      startNode: 'deep.one',
      nodes: {
        'deep.one': link('deep.one', 'deep.two'),
        'deep.two': link('deep.two', 'deep.three'),
        'deep.three': link('deep.three', 'deep.four'),
        'deep.four': link('deep.four', null),
      },
    };
  }

  const firstIndexOf = (file: string) => audioInstances.findIndex((a) => a.src.includes(file));

  it('warms the pinned passage before the opening', async () => {
    openWith('start=deep.four');
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeDeepStory();
    render(<App />);
    await screen.findByLabelText('Start the story');
    await waitFor(() => {
      expect(firstIndexOf('four.mp3')).toBeGreaterThanOrEqual(0);
      expect(firstIndexOf('one.mp3')).toBeGreaterThanOrEqual(0);
    });
    // With the sweep rooted at the story's start node, the pinned
    // passage lands in the background batch and loads last.
    expect(firstIndexOf('four.mp3')).toBeLessThan(firstIndexOf('one.mp3'));
  });

  it('still warms the opening first for an ordinary listen', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeDeepStory();
    render(<App />);
    await screen.findByLabelText('Start the story');
    await waitFor(() => {
      expect(firstIndexOf('four.mp3')).toBeGreaterThanOrEqual(0);
      expect(firstIndexOf('one.mp3')).toBeGreaterThanOrEqual(0);
    });
    expect(firstIndexOf('one.mp3')).toBeLessThan(firstIndexOf('four.mp3'));
  });
});

describe('?fresh=1 ignores saves', () => {
  it('starts at the beginning despite an autosave', async () => {
    writeAutosave('tell_you.ending');
    openWith('fresh=1');
    await renderAndStart();
    expect(await screen.findByText('The beginning.')).toBeTruthy();
  });

  it('still offers the save on the instructions screen', async () => {
    writeAutosave('tell_you.ending');
    openWith('fresh=1');
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = makeStory();
    render(<App />);
    await screen.findByLabelText('Start the story');
    expect(screen.getByText('Autosave')).toBeTruthy();
  });
});
