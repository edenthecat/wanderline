import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App, { autoAdvanceTarget } from './App';
import { fallThroughTarget } from './fall-through';

// Ink's implicit continuation: entering a knot runs its first stitch,
// and a stitch that ends without a divert continues into the next
// sibling. Neither parser materialises that as a divert — validateGraph
// explicitly skips such knots, and storyHealth walks parent/lineNumber
// to compensate for reachability.
//
// The player did not compensate. "No choices and no divert" was read as
// the end of the story, so a chapter's opening prose printed The End
// and the rest of the chapter was unreachable in playback while the
// editor showed it as perfectly healthy.

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

const knot = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'knot',
  parent: null,
  lineNumber: 1,
  content: [{ text: id + ' prose.' }],
  choices: [],
  divert: null,
  tags: [],
  ...over,
});
const stitch = (id: string, parent: string, line: number, over: Record<string, unknown> = {}) => ({
  ...knot(id, over),
  type: 'stitch',
  parent,
  lineNumber: line,
});

const chapterStory = {
  id: 'ft',
  title: 'FT',
  audioBaseUrl: './audio/',
  startNode: 'chapter',
  nodes: {
    chapter: knot('chapter'),
    'chapter.scene_one': stitch('chapter.scene_one', 'chapter', 4),
    'chapter.scene_two': stitch('chapter.scene_two', 'chapter', 8, { divert: 'END' }),
  },
};

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

describe('fallThroughTarget', () => {
  const nodes = chapterStory.nodes as unknown as Record<
    string,
    { id: string; type?: string; parent?: string | null; lineNumber?: number }
  >;

  it('sends a knot into its first stitch by line order', () => {
    expect(fallThroughTarget('chapter', chapterStory.nodes.chapter, nodes)).toBe(
      'chapter.scene_one',
    );
  });

  it('sends a stitch into its next sibling', () => {
    expect(
      fallThroughTarget('chapter.scene_one', chapterStory.nodes['chapter.scene_one'], nodes),
    ).toBe('chapter.scene_two');
  });

  it('stops at the last stitch', () => {
    expect(
      fallThroughTarget('chapter.scene_two', chapterStory.nodes['chapter.scene_two'], nodes),
    ).toBeNull();
  });

  it('leaves a passage with its own way forward alone', () => {
    expect(fallThroughTarget('k', knot('k', { divert: 'somewhere' }), nodes)).toBeNull();
    expect(fallThroughTarget('k', knot('k', { choices: [{ target: 'x' }] }), nodes)).toBeNull();
  });

  it('reports a knot with no stitches as a real terminus', () => {
    expect(fallThroughTarget('lonely', knot('lonely'), { lonely: knot('lonely') })).toBeNull();
  });
});

describe('auto-advance across a fall-through', () => {
  const nodes = chapterStory.nodes as unknown as Record<
    string,
    { id: string; type?: string; parent?: string | null; lineNumber?: number }
  >;

  it('advances into the first stitch when enabled', () => {
    expect(autoAdvanceTarget(chapterStory.nodes.chapter, { autoAdvance: true }, nodes)).toBe(
      'chapter.scene_one',
    );
  });

  it('stays put when the listener has it off', () => {
    expect(autoAdvanceTarget(chapterStory.nodes.chapter, { autoAdvance: false }, nodes)).toBeNull();
  });
});

describe('offline download order', () => {
  it('does not strand every stitch after a chapter opening', async () => {
    const { orderNodesByReachability } = await import('./audio-download-order');
    // `orphan` is declared FIRST and genuinely unreachable. Without a
    // fall-through edge the stitches are unreachable too, so they land
    // in the same trailing block and sort behind the orphan — which is
    // what makes this assertion able to fail. A fixture of only
    // reachable-by-fall-through nodes passes either way, because the
    // trailing block happens to reproduce declaration order.
    const order = orderNodesByReachability({
      id: 'ft',
      startNode: 'chapter',
      audioBaseUrl: './audio/',
      nodes: {
        orphan: knot('orphan', { divert: 'END' }),
        chapter: chapterStory.nodes.chapter,
        'chapter.scene_one': chapterStory.nodes['chapter.scene_one'],
      },
    } as unknown as Parameters<typeof orderNodesByReachability>[0]);
    // The chapter's own continuation must be saved before authoring
    // debris, or an interrupted download keeps the opening and drops
    // the rest of the chapter.
    expect(order).toEqual(['chapter', 'chapter.scene_one', 'orphan']);
  });
});

describe('a chapter that opens with prose', () => {
  it('does not print The End on the knot', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = chapterStory;
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    expect(await screen.findByText('chapter prose.')).toBeTruthy();
    expect(screen.queryByText('The End')).toBeNull();
  });

  it('offers Continue into the rest of the chapter', async () => {
    (window as unknown as Record<string, unknown>).__WANDERLINE_STORY__ = chapterStory;
    render(<App />);
    fireEvent.click(await screen.findByLabelText('Start the story'));
    fireEvent.click(await screen.findByLabelText('Continue to next part of the story'));
    expect(await screen.findByText('chapter.scene_one prose.')).toBeTruthy();
  });
});
