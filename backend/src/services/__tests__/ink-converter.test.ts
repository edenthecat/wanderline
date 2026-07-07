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
});
