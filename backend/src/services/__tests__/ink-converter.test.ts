import { convertStoryGraphToInk } from '../ink-converter.js';
import { parseInk } from '../ink-parser.js';

// A round-trip re-parses from scratch, so the two sides' randomUUID()
// `id`s (DEV-199 stable-id rollout) are never equal by construction —
// strip them from both sides before comparing everything else.
function stripIds<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v) => (key === 'id' ? undefined : v));
}

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
          content: [{ kind: 'text', text: 'Hello world!', tags: [] }],
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
          content: [{ kind: 'text', text: 'Choose:', tags: [] }],
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
          content: [{ kind: 'text', text: 'You went left.', tags: [] }],
          choices: [],
          divert: 'END',
          tags: [],
        },
        right: {
          id: 'right',
          type: 'knot',
          content: [{ kind: 'text', text: 'You went right.', tags: [] }],
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
          content: [{ kind: 'text', text: 'Moving on...', tags: [] }],
          choices: [],
          divert: 'next',
          tags: [],
        },
        next: {
          id: 'next',
          type: 'knot',
          content: [{ kind: 'text', text: 'Next section.', tags: [] }],
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
          content: [{ kind: 'text', text: 'Begin', tags: [] }],
          choices: [],
          divert: 'start.sub',
          tags: [],
        },
        'start.sub': {
          id: 'start.sub',
          type: 'stitch',
          content: [{ kind: 'text', text: 'Sub content', tags: [] }],
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
          content: [{ kind: 'text', text: 'Tagged line', tags: ['speaker:narrator'] }],
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
          content: [{ kind: 'text', text: 'Chapter 1', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
        },
        chapter2: {
          id: 'chapter2',
          type: 'knot',
          content: [{ kind: 'text', text: 'Chapter 2', tags: [] }],
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

  describe('Variable declarations and assignment (DEV-199 Phase 1)', () => {
    it('emits VAR/CONST declarations before any knot content', () => {
      const result = convertStoryGraphToInk({
        id: 'test',
        title: 'Test',
        startNode: 'start',
        variables: [
          {
            name: 'gold',
            type: 'number',
            initialValue: { kind: 'literal', value: 50 },
            isConst: false,
          },
          {
            name: 'max_health',
            type: 'number',
            initialValue: { kind: 'literal', value: 100 },
            isConst: true,
          },
        ],
        nodes: {
          start: {
            id: 'start',
            type: 'knot',
            content: [{ kind: 'text', text: 'Hi.', tags: [] }],
            choices: [],
            divert: null,
            tags: [],
          },
        },
      });
      expect(result).toContain('VAR gold = 50');
      expect(result).toContain('CONST max_health = 100');
      expect(result.indexOf('VAR gold = 50')).toBeLessThan(result.indexOf('=== start ==='));
    });

    it('emits an assignment block as a `~` statement', () => {
      const result = convertStoryGraphToInk({
        id: 'test',
        title: 'Test',
        startNode: 'start',
        nodes: {
          start: {
            id: 'start',
            type: 'knot',
            content: [
              { kind: 'text', text: 'Before.', tags: [] },
              {
                kind: 'assignment',
                statement: {
                  kind: 'assignment',
                  name: 'gold',
                  operator: '+=',
                  value: { kind: 'literal', value: 10 },
                },
              },
              { kind: 'text', text: 'After.', tags: [] },
            ],
            choices: [],
            divert: null,
            tags: [],
          },
        },
      });
      const lines = result.split('\n').filter(Boolean);
      expect(lines.indexOf('Before.')).toBeLessThan(lines.indexOf('~ gold += 10'));
      expect(lines.indexOf('~ gold += 10')).toBeLessThan(lines.indexOf('After.'));
    });

    it('round-trips VAR declarations and in-content assignment through parseInk -> emit -> parseInk', () => {
      const source = [
        'VAR gold = 50',
        '',
        '== start ==',
        'Before.',
        '~ gold += 10',
        'After.',
        '-> END',
        '',
      ].join('\n');
      const first = parseInk(source, 'test-id');
      const emitted = convertStoryGraphToInk(first);
      const second = parseInk(emitted, 'test-id');
      expect(second.variables).toEqual(first.variables);
      expect(stripIds(second.nodes['start'].content)).toEqual(
        stripIds(first.nodes['start'].content),
      );
    });
  });

  describe('Conditional text (DEV-199 Phase 3)', () => {
    it('wraps a conditional text block in `{condition: text}` on emit', () => {
      const result = convertStoryGraphToInk({
        id: 'test',
        title: 'Test',
        startNode: 'start',
        nodes: {
          start: {
            id: 'start',
            type: 'knot',
            content: [
              {
                kind: 'text',
                text: 'You have plenty of gold.',
                tags: [],
                condition: {
                  kind: 'binary',
                  operator: '>',
                  left: { kind: 'variable', name: 'gold' },
                  right: { kind: 'literal', value: 10 },
                },
              },
            ],
            choices: [],
            divert: null,
            tags: [],
          },
        },
      });
      expect(result).toContain('{gold > 10: You have plenty of gold.}');
    });

    it('puts a trailing tag after the closing brace', () => {
      const result = convertStoryGraphToInk({
        id: 'test',
        title: 'Test',
        startNode: 'start',
        nodes: {
          start: {
            id: 'start',
            type: 'knot',
            content: [
              {
                kind: 'text',
                text: 'Rich.',
                tags: ['narrator:smug'],
                condition: { kind: 'variable', name: 'rich' },
              },
            ],
            choices: [],
            divert: null,
            tags: [],
          },
        },
      });
      expect(result).toContain('{rich: Rich.} # narrator:smug');
    });

    it('round-trips conditional text through parseInk -> emit -> parseInk', () => {
      const source = [
        '== start ==',
        '{gold > 10 && seen_market: You remember the well-stocked market.}',
        'Always shown.',
        '-> END',
        '',
      ].join('\n');
      const first = parseInk(source, 'test-id');
      const emitted = convertStoryGraphToInk(first);
      const second = parseInk(emitted, 'test-id');
      expect(stripIds(second.nodes['start'].content)).toEqual(
        stripIds(first.nodes['start'].content),
      );
    });
  });

  describe('Conditional choice visibility (DEV-199 Phase 4)', () => {
    it('emits a choice condition as a `{condition}` prefix', () => {
      const result = convertStoryGraphToInk({
        id: 'test',
        title: 'Test',
        startNode: 'start',
        nodes: {
          start: {
            id: 'start',
            type: 'knot',
            content: [{ kind: 'text', text: 'Question?', tags: [] }],
            choices: [
              {
                text: 'Buy something',
                target: 'shop',
                condition: {
                  kind: 'binary',
                  operator: '>',
                  left: { kind: 'variable', name: 'gold' },
                  right: { kind: 'literal', value: 10 },
                },
              },
            ],
            divert: null,
            tags: [],
          },
          shop: {
            id: 'shop',
            type: 'knot',
            content: [{ kind: 'text', text: 'Hi.', tags: [] }],
            choices: [],
            divert: null,
            tags: [],
          },
        },
      });
      expect(result).toContain('* {gold > 10} [Buy something] -> shop');
    });

    it('emits no prefix for a choice with no condition', () => {
      const result = convertStoryGraphToInk({
        id: 'test',
        title: 'Test',
        startNode: 'start',
        nodes: {
          start: {
            id: 'start',
            type: 'knot',
            content: [{ kind: 'text', text: 'Hi.', tags: [] }],
            choices: [{ text: 'Leave', target: 'END' }],
            divert: null,
            tags: [],
          },
        },
      });
      expect(result).toContain('* [Leave] -> END');
    });

    it('round-trips a conditional choice through parseInk -> emit -> parseInk', () => {
      const source = [
        '== start ==',
        'Question?',
        '',
        '* {gold > 10}{seen_market} Buy something -> shop',
        '* Leave -> END',
        '',
        '== shop ==',
        'Hi.',
        '',
      ].join('\n');
      const first = parseInk(source, 'test-id');
      const emitted = convertStoryGraphToInk(first);
      const second = parseInk(emitted, 'test-id');
      expect(stripIds(second.nodes['start'].choices)).toEqual(
        stripIds(first.nodes['start'].choices),
      );
    });
  });

  describe('LIST declarations (DEV-199 Phase 10)', () => {
    it('emits every declared member, with the active ones parenthesized', () => {
      const result = convertStoryGraphToInk({
        id: 'test',
        title: 'Test',
        startNode: 'start',
        variables: [
          {
            name: 'kettleState',
            type: 'list',
            isConst: false,
            listMembers: ['cold', 'boiling', 'recently_boiled'],
            initialValue: {
              kind: 'literal',
              value: {
                kind: 'list',
                origin: 'kettleState',
                items: [{ name: 'boiling', ordinal: 1 }],
                allItems: [
                  { name: 'cold', ordinal: 0 },
                  { name: 'boiling', ordinal: 1 },
                  { name: 'recently_boiled', ordinal: 2 },
                ],
              },
            },
          },
        ],
        nodes: {
          start: {
            id: 'start',
            type: 'knot',
            content: [{ kind: 'text', text: 'Hi.', tags: [] }],
            choices: [],
            divert: null,
            tags: [],
          },
        },
      });
      expect(result).toContain('LIST kettleState = cold, (boiling), recently_boiled');
    });

    it('round-trips a LIST declaration, its condition, and an in-content assignment through parseInk -> emit -> parseInk', () => {
      const source = [
        'LIST kettleState = cold, (boiling), recently_boiled',
        '',
        '== start ==',
        '~ kettleState += recently_boiled',
        '{kettleState == boiling: It is boiling.}',
        '-> END',
        '',
      ].join('\n');
      const first = parseInk(source, 'test-id');
      const emitted = convertStoryGraphToInk(first);
      const second = parseInk(emitted, 'test-id');
      expect(second.variables).toEqual(first.variables);
      expect(stripIds(second.nodes['start'].content)).toEqual(
        stripIds(first.nodes['start'].content),
      );
    });
  });
});
