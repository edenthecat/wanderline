import { describe, expect, it, vi } from 'vitest';
import type { StoryGraph, StoryNode } from '../../api/client';
import {
  buildCommands,
  passageProvider,
  PASSAGE_GROUP,
  type CommandProvider,
  type PaletteActions,
} from '../commandPalette';

function node(id: string, ...lines: string[]): StoryNode {
  return {
    id,
    type: 'knot',
    parent: null,
    content: lines.map((text) => ({ text, tags: [] })),
    choices: [],
    divert: null,
    tags: [],
    lineNumber: 1,
  };
}

// Keyed the way a stored graph is: the record key IS the identity the
// palette offers and the tabs resolve.
function graph(...nodes: StoryNode[]): StoryGraph {
  return {
    id: 'g1',
    title: 'Test story',
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    startNode: nodes[0]?.id ?? '',
    validation: { valid: true, errors: [], warnings: [] },
  };
}

const actions = (): PaletteActions => ({ jumpToNode: vi.fn() });

describe('passageProvider', () => {
  it('offers every passage when nothing is typed', () => {
    const commands = passageProvider({
      query: '',
      storyGraph: graph(node('intro'), node('harbour')),
      actions: actions(),
    });
    expect(commands.map((c) => c.label)).toEqual(['intro', 'harbour']);
    expect(commands.every((c) => c.group === PASSAGE_GROUP)).toBe(true);
  });

  it('filters with the same rule the tab search boxes use', () => {
    const commands = passageProvider({
      query: 'gull',
      storyGraph: graph(node('intro', 'Gulls overhead.'), node('harbour', 'Quiet.')),
      actions: actions(),
    });
    expect(commands.map((c) => c.label)).toEqual(['intro']);
  });

  it('shows a content excerpt as the hint', () => {
    const [command] = passageProvider({
      query: 'intro',
      storyGraph: graph(node('intro', 'A cold morning.')),
      actions: actions(),
    });
    expect(command.hint).toBe('A cold morning.');
  });

  it('runs the jump action for its own node', () => {
    const act = actions();
    const [command] = passageProvider({
      query: 'harbour',
      storyGraph: graph(node('intro'), node('harbour')),
      actions: act,
    });
    command.run();
    expect(act.jumpToNode).toHaveBeenCalledWith('harbour');
  });

  it("offers the record key, not the node body's own id field", () => {
    // Legacy stored graphs can disagree, and a jump is resolved by
    // key downstream — offering node.id would drop the jump silently.
    const stored = graph(node('intro'));
    stored.nodes.record_key = { ...node('intro'), id: 'stale_id' };
    const commands = passageProvider({ query: 'record', storyGraph: stored, actions: actions() });
    expect(commands.map((c) => c.label)).toEqual(['record_key']);
  });

  it('returns nothing when the project has no story yet', () => {
    expect(passageProvider({ query: '', storyGraph: null, actions: actions() })).toEqual([]);
  });
});

describe('buildCommands', () => {
  it('puts the best id match first and keeps story order for ties', () => {
    const result = buildCommands({
      query: 'harbour',
      storyGraph: graph(
        node('docks', 'down at the harbour'),
        node('the_harbour'),
        node('harbour'),
        node('harbour_night'),
      ),
      actions: actions(),
    });
    expect(result.commands.map((c) => c.label)).toEqual([
      'harbour',
      'harbour_night',
      'the_harbour',
      'docks',
    ]);
  });

  it('caps the list but reports the true total', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(`n${i}`));
    const result = buildCommands(
      { query: '', storyGraph: graph(...nodes), actions: actions() },
      undefined,
      3,
    );
    expect(result.commands).toHaveLength(3);
    expect(result.totalCount).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated when everything fits', () => {
    const result = buildCommands({
      query: '',
      storyGraph: graph(node('a'), node('b')),
      actions: actions(),
    });
    expect(result.truncated).toBe(false);
    expect(result.totalCount).toBe(2);
  });

  // The whole point of the provider list: a new verb is a new entry,
  // not a rewrite of the palette component.
  it('keeps each provider group contiguous and in first-seen order', () => {
    const extra: CommandProvider = () => [
      { id: 'x1', group: 'Flags', label: 'Jump to flag', rank: 0, run: () => {} },
    ];
    const result = buildCommands(
      { query: '', storyGraph: graph(node('a'), node('b')), actions: actions() },
      [passageProvider, extra],
    );
    expect(result.commands.map((c) => c.group)).toEqual([PASSAGE_GROUP, PASSAGE_GROUP, 'Flags']);
  });

  it('tolerates a provider that has nothing to offer', () => {
    const result = buildCommands({ query: '', storyGraph: null, actions: actions() });
    expect(result.commands).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});
