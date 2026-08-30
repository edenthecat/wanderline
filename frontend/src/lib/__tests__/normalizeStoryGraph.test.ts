// Bare stitch targets on graphs that were stored before the parser fix.
//
// The backend never reported these: validateGraph suffix-matches bare
// targets, so it emitted no missing_target, and it never emits
// unreachable_node for a dotted id. The symptom was entirely in the
// editor, where several consumers key on exact node ids — the choice
// and divert dropdowns, the graph tab's "missing" nodes, the
// "Reachable from" list, and story health's walk. Qualifying once at
// the API boundary is what keeps them agreeing with each other.

import { describe, expect, it } from 'vitest';
import { normalizeStoryGraph } from '../normalizeStoryGraph';
import { computeStoryHealth } from '../storyHealth';
import type { StoryGraph } from '../../api/client';

let line = 0;
const node = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  // Real graphs carry type/parent/lineNumber, and computeStoryHealth's
  // Ink fall-through walk keys off all three. A helper that omits them
  // leaves those branches inert and quietly makes reachability
  // assertions vacuous.
  type: id.includes('.') ? 'stitch' : 'knot',
  parent: id.includes('.') ? id.split('.')[0] : null,
  lineNumber: ++line,
  content: [{ text: 'x', tags: [] }],
  choices: [],
  divert: null,
  tags: [],
  ...over,
});

function graph(nodes: Record<string, unknown>, startNode = 'inbox'): StoryGraph {
  return {
    id: 'g',
    title: 't',
    startNode,
    nodes,
    validation: { errors: [], warnings: [] },
  } as unknown as StoryGraph;
}

describe('normalizeStoryGraph', () => {
  it('qualifies a bare choice target against its own knot', () => {
    const g = normalizeStoryGraph(
      graph({
        inbox: node('inbox', { choices: [{ text: 'read', target: 'read_email_5' }] }),
        'inbox.read_email_5': node('inbox.read_email_5', { divert: 'END' }),
      }),
    );
    expect(g.nodes['inbox'].choices[0].target).toBe('inbox.read_email_5');
  });

  it('qualifies a bare divert against its own knot', () => {
    const g = normalizeStoryGraph(
      graph({
        inbox: node('inbox', { divert: 'read_email_5' }),
        'inbox.read_email_5': node('inbox.read_email_5', { divert: 'END' }),
      }),
    );
    expect(g.nodes['inbox'].divert).toBe('inbox.read_email_5');
  });

  it('leaves a target that names nothing alone, so it still reads as missing', () => {
    const g = normalizeStoryGraph(
      graph({ inbox: node('inbox', { choices: [{ text: 'go', target: 'nowhere_at_all' }] }) }),
    );
    // Rewriting it would hide a real broken link behind a plausible id.
    expect(g.nodes['inbox'].choices[0].target).toBe('nowhere_at_all');
  });

  it('leaves terminal targets alone', () => {
    const g = normalizeStoryGraph(
      graph({
        inbox: node('inbox', {
          choices: [
            { text: 'a', target: 'END' },
            { text: 'b', target: 'DONE' },
          ],
        }),
      }),
    );
    expect(g.nodes['inbox'].choices.map((c: { target: string }) => c.target)).toEqual([
      'END',
      'DONE',
    ]);
  });

  it('prefers an exact match over the knot-local stitch', () => {
    const g = normalizeStoryGraph(
      graph({
        inbox: node('inbox', { choices: [{ text: 'go', target: 'shared' }] }),
        'inbox.shared': node('inbox.shared', { divert: 'END' }),
        shared: node('shared', { divert: 'END' }),
      }),
    );
    expect(g.nodes['inbox'].choices[0].target).toBe('shared');
  });

  it('does not reach into another knot to satisfy a bare name', () => {
    const g = normalizeStoryGraph(
      graph({
        inbox: node('inbox', { choices: [{ text: 'go', target: 'far_away' }] }),
        other: node('other', { divert: 'END' }),
        'other.far_away': node('other.far_away', { divert: 'END' }),
      }),
    );
    // Two tiers only, matching resolveBareStitchTargets and the build's
    // own gate. A third would draw a solid edge here for a story the
    // build rejects.
    expect(g.nodes['inbox'].choices[0].target).toBe('far_away');
  });

  it('leaves untouched nodes strictly identical', () => {
    const g = graph({
      inbox: node('inbox', { choices: [{ text: 'read', target: 'read_email_5' }] }),
      'inbox.read_email_5': node('inbox.read_email_5', { divert: 'END' }),
      elsewhere: node('elsewhere', { divert: 'END' }),
    });
    const out = normalizeStoryGraph(g);
    // Only the node that needed qualifying is rebuilt.
    expect(out.nodes['elsewhere']).toBe(g.nodes['elsewhere']);
    expect(out.nodes['inbox']).not.toBe(g.nodes['inbox']);
  });

  it('returns the same object when there is nothing to qualify', () => {
    const g = graph({
      inbox: node('inbox', { choices: [{ text: 'go', target: 'inbox.one' }] }),
      'inbox.one': node('inbox.one', { divert: 'END' }),
    });
    expect(normalizeStoryGraph(g)).toBe(g);
  });

  it('passes null through', () => {
    expect(normalizeStoryGraph(null)).toBeNull();
  });

  it('leaves Twee graphs alone — no knot scoping there', () => {
    // `Hall.Door` / `Hall.Key` are ordinary Twee passage names, and
    // `[[Key]]` is a genuinely broken link the parser reports as an
    // error. Qualifying it would repoint it at a real passage.
    const g = graph(
      {
        'Hall.Door': node('Hall.Door', { choices: [{ text: 'k', target: 'Key' }] }),
        'Hall.Key': node('Hall.Key', { divert: 'END' }),
      },
      'Hall.Door',
    );
    expect(normalizeStoryGraph(g, 'twee')).toBe(g);
    // Same graph read as Ink would qualify — that's the difference.
    expect(normalizeStoryGraph(g, 'ink').nodes['Hall.Door'].choices[0].target).toBe('Hall.Key');
  });

  it("rewrites a node's own id to the key it is filed under", () => {
    // Every lookup in the app is `nodes[id]`, so the record key is the
    // real identity; a stale `node.id` shows a passage in one tab that
    // the other can't find. The backend's rename cascade only rewrites
    // a stitch's own id when it already matched its key.
    const g = normalizeStoryGraph(
      graph({ start: node('start'), 'start.two': node('stale_id', { type: 'stitch' }) }, 'start'),
      'ink',
    );
    expect(g.nodes['start.two'].id).toBe('start.two');
    expect(g.nodes.start.id).toBe('start');
  });

  it('repairs node ids on Twee graphs too, where target scoping does not apply', () => {
    const g = graph(
      {
        'Hall.Door': node('stale', { choices: [{ text: 'k', target: 'Key' }] }),
        'Hall.Key': node('Hall.Key', { divert: 'END' }),
      },
      'Hall.Door',
    );
    const out = normalizeStoryGraph(g, 'twee');
    expect(out.nodes['Hall.Door'].id).toBe('Hall.Door');
    // ...and the broken bare target is still left alone.
    expect(out.nodes['Hall.Door'].choices[0].target).toBe('Key');
  });

  it('keeps a node named __proto__', () => {
    const g = normalizeStoryGraph(
      graph({
        inbox: node('inbox', { choices: [{ text: 'go', target: 'read_email_5' }] }),
        'inbox.read_email_5': node('inbox.read_email_5', { divert: 'END' }),
        // Computed key: the literal form `__proto__:` sets the
        // prototype instead of creating an own property, so the
        // fixture would never contain the node it means to test.
        ['__proto__']: node('__proto__', { divert: 'END' }),
      }),
    );
    // A plain object literal would swallow this assignment entirely.
    expect(Object.keys(g.nodes)).toContain('__proto__');
  });
});

describe('story health on a normalized legacy graph', () => {
  // The reported symptom end to end: a run of passages listed as
  // unreachable in a story where nothing was wrong.
  it('no longer reports a bare-target stitch as unreachable', () => {
    const legacy = graph({
      inbox: node('inbox', { choices: [{ text: 'read', target: 'read_email_5' }] }),
      'inbox.read_email_5': node('inbox.read_email_5', { divert: 'END' }),
    });
    expect(computeStoryHealth(legacy).unreachableNodes).toContain('inbox.read_email_5');
    expect(computeStoryHealth(normalizeStoryGraph(legacy)).unreachableNodes).not.toContain(
      'inbox.read_email_5',
    );
  });

  it('still reports a genuinely orphaned knot', () => {
    const g = normalizeStoryGraph(
      graph({
        inbox: node('inbox', { choices: [{ text: 'read', target: 'read_email_5' }] }),
        'inbox.read_email_5': node('inbox.read_email_5', { divert: 'END' }),
        // Nothing diverts or chooses into this, and it is not a stitch
        // of anything, so no fall-through reaches it either.
        lonely: node('lonely', { divert: 'END' }),
      }),
    );
    // Qualification must not become "everything is reachable".
    expect(computeStoryHealth(g).unreachableNodes).toContain('lonely');
  });
});
