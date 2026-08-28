import { convertStoryGraphToInk } from '../ink-converter.js';

describe('convertStoryGraphToInk', () => {
  it('should convert a simple knot to Ink format', () => {
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'start',
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [{ text: 'Hello world!', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
        },
      },
    });

    expect(result).toContain('=== start ===');
    expect(result).toContain('Hello world!');
  });

  it('should convert choices with targets', () => {
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'start',
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [{ text: 'Choose:', tags: [] }],
          choices: [
            { text: 'Go left', target: 'left' },
            { text: 'Go right', target: 'right' },
          ],
          divert: null,
          tags: [],
        },
        left: {
          id: 'left',
          type: 'knot',
          content: [{ text: 'You went left.', tags: [] }],
          choices: [],
          divert: 'END',
          tags: [],
        },
        right: {
          id: 'right',
          type: 'knot',
          content: [{ text: 'You went right.', tags: [] }],
          choices: [],
          divert: 'END',
          tags: [],
        },
      },
    });

    expect(result).toContain('* [Go left] -> left');
    expect(result).toContain('* [Go right] -> right');
    expect(result).toContain('-> END');
  });

  it('should convert diverts', () => {
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'start',
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [{ text: 'Moving on...', tags: [] }],
          choices: [],
          divert: 'next',
          tags: [],
        },
        next: {
          id: 'next',
          type: 'knot',
          content: [{ text: 'Next section.', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
        },
      },
    });

    expect(result).toContain('-> next');
  });

  it('should convert stitches with short form targets', () => {
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'start',
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [{ text: 'Begin', tags: [] }],
          choices: [],
          divert: 'start.sub',
          tags: [],
        },
        'start.sub': {
          id: 'start.sub',
          type: 'stitch',
          content: [{ text: 'Sub content', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
        },
      },
    });

    expect(result).toContain('=== start ===');
    expect(result).toContain('= sub');
    // Divert to stitch in same knot should use short form
    expect(result).toContain('-> sub');
  });

  it('should include inline content tags', () => {
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'start',
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [{ text: 'Tagged line', tags: ['speaker:narrator'] }],
          choices: [],
          divert: null,
          tags: [],
        },
      },
    });

    expect(result).toContain('Tagged line # speaker:narrator');
  });

  it('should put start node first', () => {
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'chapter2',
      nodes: {
        chapter1: {
          id: 'chapter1',
          type: 'knot',
          content: [{ text: 'Chapter 1', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
        },
        chapter2: {
          id: 'chapter2',
          type: 'knot',
          content: [{ text: 'Chapter 2', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
        },
      },
    });

    const ch1Pos = result.indexOf('=== chapter1 ===');
    const ch2Pos = result.indexOf('=== chapter2 ===');
    expect(ch2Pos).toBeLessThan(ch1Pos);
  });

  // Ink runs stitches in the order they appear: one that ends without
  // a divert falls through to the next sibling. Emitting them
  // alphabetically would rewrite the story on the next import — and
  // silently discard where an author placed a newly created passage.
  it('emits stitches in story order, not alphabetical order', () => {
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'chapter1',
      nodes: {
        chapter1: {
          id: 'chapter1',
          type: 'knot',
          content: [],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 1,
        },
        'chapter1.alpha': {
          id: 'chapter1.alpha',
          type: 'stitch',
          content: [{ text: 'A', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 2,
        },
        'chapter1.zulu': {
          id: 'chapter1.zulu',
          type: 'stitch',
          content: [{ text: 'Z', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 3,
        },
        'chapter1.beta': {
          id: 'chapter1.beta',
          type: 'stitch',
          content: [{ text: 'B', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 4,
        },
      },
    });

    expect(result.indexOf('= alpha')).toBeLessThan(result.indexOf('= zulu'));
    expect(result.indexOf('= zulu')).toBeLessThan(result.indexOf('= beta'));
  });

  // `.` is path syntax in an Ink target, not a character in a name.
  // Sanitising it to `_` produced `-> k1_intro` for a stitch whose
  // header is `= intro` under `=== k1 ===` — a target naming nothing.
  it('emits a cross-knot stitch target as a path, not a flattened name', () => {
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'k1',
      nodes: {
        k1: {
          id: 'k1',
          type: 'knot',
          content: [],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 1,
        },
        'k1.intro': {
          id: 'k1.intro',
          type: 'stitch',
          content: [{ text: 'A', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 2,
        },
        k2: {
          id: 'k2',
          type: 'knot',
          content: [],
          choices: [],
          divert: 'k1.intro',
          tags: [],
          lineNumber: 3,
        },
      },
    });

    expect(result).toContain('-> k1.intro');
    expect(result).not.toContain('k1_intro');
  });

  // A Twee passage may legitimately be called `Ch1.Scene`. It exports
  // as the knot `Ch1_Scene`, so references to it must stay flattened.
  it('does not turn a dotted top-level passage name into a path', () => {
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'Start',
      nodes: {
        Start: {
          id: 'Start',
          type: 'knot',
          content: [],
          choices: [],
          divert: 'Ch1.Scene',
          tags: [],
          lineNumber: 1,
        },
        Ch1: { id: 'Ch1', type: 'knot', content: [], choices: [], divert: null, tags: [] },
        'Ch1.Scene': {
          id: 'Ch1.Scene',
          type: 'knot',
          content: [{ text: 'A', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
        },
      },
    });

    expect(result).toContain('-> Ch1_Scene');
    expect(result).toContain('=== Ch1_Scene ===');
  });

  // Knots too — a chapter placed after another has to come out after
  // it, whatever the two are called.
  it('emits knots in story order after the start knot', () => {
    const knot = (id: string, lineNumber: number) => ({
      id,
      type: 'knot' as const,
      content: [],
      choices: [],
      divert: null,
      tags: [],
      lineNumber,
    });
    const result = convertStoryGraphToInk({
      id: 'test',
      title: 'Test',
      startNode: 'intro',
      nodes: {
        intro: knot('intro', 1),
        zulu: knot('zulu', 2),
        alpha: knot('alpha', 3),
      },
    });

    expect(result.indexOf('=== intro ===')).toBeLessThan(result.indexOf('=== zulu ==='));
    expect(result.indexOf('=== zulu ===')).toBeLessThan(result.indexOf('=== alpha ==='));
  });
});
