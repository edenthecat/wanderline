import { describe, expect, it } from 'vitest';
import {
  orderAudioUrlsForDownload,
  orderNodesByReachability,
  type OrderableStory,
} from './audio-download-order';

// A short linear story with a branch, plus one node nothing points at.
function story(overrides: Partial<OrderableStory> = {}): OrderableStory {
  return {
    audioBaseUrl: './audio/',
    startNode: 'start',
    nodes: {
      // Declaration order is deliberately NOT narrative order — that's
      // the bug this module exists to fix.
      late: { choices: [], divert: 'END', audio: { voiceover: 'late.mp3' } },
      orphan: { choices: [], divert: null, audio: { voiceover: 'orphan.mp3' } },
      start: { choices: [{ target: 'middle' }], divert: null, audio: { voiceover: 'start.mp3' } },
      middle: { choices: [{ target: 'late' }], divert: null, audio: { voiceover: 'middle.mp3' } },
    },
    ...overrides,
  };
}

describe('orderNodesByReachability', () => {
  it('walks breadth-first from the start node', () => {
    expect(orderNodesByReachability(story())).toEqual(['start', 'middle', 'late', 'orphan']);
  });

  // Unreachable nodes are usually authoring debris, but a save slot
  // can still land a reader on one, so download them last rather than
  // not at all.
  it('appends unreachable nodes after the reachable ones', () => {
    const order = orderNodesByReachability(story());
    expect(order[order.length - 1]).toBe('orphan');
  });

  // Choices and diverts out of the Ink compiler are routinely bare
  // stitch names. Queueing them raw and dropping whatever wasn't an
  // exact id stopped the walk at the first one, so nearly every passage
  // fell into the unreachable tail and the ordering degenerated to
  // declaration order — exactly what this module exists to prevent.
  it('follows references written as bare stitch names', () => {
    const s = story({
      startNode: 'tell_you.opening',
      nodes: {
        'tell_you.ending': { choices: [], divert: 'END' },
        'tell_you.opening': { choices: [{ target: 'middle' }], divert: null },
        'tell_you.middle': { choices: [], divert: 'ending' },
      },
    });
    expect(orderNodesByReachability(s)).toEqual([
      'tell_you.opening',
      'tell_you.middle',
      'tell_you.ending',
    ]);
  });

  it.each(['END', 'DONE'])('does not treat %s as a node', (target) => {
    const s = story({
      nodes: { start: { choices: [{ target }], divert: null } },
      startNode: 'start',
    });
    expect(orderNodesByReachability(s)).toEqual(['start']);
  });

  // A story that loops back on itself must not hang the walk.
  it('terminates on a cycle', () => {
    const s = story({
      startNode: 'a',
      nodes: {
        a: { choices: [{ target: 'b' }], divert: null },
        b: { choices: [{ target: 'a' }], divert: null },
      },
    });
    expect(orderNodesByReachability(s)).toEqual(['a', 'b']);
  });

  it('ignores choices pointing at nodes that do not exist', () => {
    const s = story({
      startNode: 'a',
      nodes: { a: { choices: [{ target: 'ghost' }], divert: null } },
    });
    expect(orderNodesByReachability(s)).toEqual(['a']);
  });

  it('follows diverts as well as choices', () => {
    const s = story({
      startNode: 'a',
      nodes: {
        a: { choices: [], divert: 'b' },
        b: { choices: [], divert: null },
      },
    });
    expect(orderNodesByReachability(s)).toEqual(['a', 'b']);
  });
});

describe('orderAudioUrlsForDownload', () => {
  // The headline guarantee: download front-to-back and you have the
  // opening of the story, not a random 60% of it.
  it('orders node audio by story order, not declaration order', () => {
    const urls = orderAudioUrlsForDownload(story());
    expect(urls).toEqual([
      './audio/start.mp3',
      './audio/middle.mp3',
      './audio/late.mp3',
      './audio/orphan.mp3',
    ]);
  });

  // Cues are tiny and used on every choice; a story with chapters but
  // no cues feels broken in a way fewer chapters does not.
  it('puts indicators and the first music track ahead of node audio', () => {
    const urls = orderAudioUrlsForDownload(
      story({
        indicatorAudio: { choice1: 'c1.mp3', choice2: 'c2.mp3' },
        backgroundMusic: ['bgm1.mp3', 'bgm2.mp3'],
      }),
    );
    expect(urls.slice(0, 3)).toEqual(['./audio/c1.mp3', './audio/c2.mp3', './audio/bgm1.mp3']);
    // Later tracks are pleasant, not essential — they go last.
    expect(urls[urls.length - 1]).toBe('./audio/bgm2.mp3');
  });

  it('keeps a shared file at its earliest position', () => {
    const s = story({
      startNode: 'a',
      nodes: {
        a: { choices: [{ target: 'b' }], divert: null, audio: { voiceover: 'shared.mp3' } },
        b: { choices: [], divert: null, audio: { voiceover: 'shared.mp3' } },
      },
    });
    expect(orderAudioUrlsForDownload(s)).toEqual(['./audio/shared.mp3']);
  });

  it('includes every audio kind on a node', () => {
    const s = story({
      startNode: 'a',
      nodes: {
        a: {
          choices: [],
          divert: null,
          audio: { voiceover: 'v.mp3', choice1: 'c1.mp3', choice2: 'c2.mp3', ambience: 'am.mp3' },
        },
      },
    });
    expect(orderAudioUrlsForDownload(s)).toEqual([
      './audio/v.mp3',
      './audio/c1.mp3',
      './audio/c2.mp3',
      './audio/am.mp3',
    ]);
  });

  it('normalises a base URL with no trailing slash', () => {
    const s = story({
      audioBaseUrl: './audio',
      startNode: 'a',
      nodes: { a: { choices: [], divert: null, audio: { voiceover: 'v.mp3' } } },
    });
    expect(orderAudioUrlsForDownload(s)).toEqual(['./audio/v.mp3']);
  });

  it('returns nothing for a missing story', () => {
    expect(orderAudioUrlsForDownload(null)).toEqual([]);
  });
});
