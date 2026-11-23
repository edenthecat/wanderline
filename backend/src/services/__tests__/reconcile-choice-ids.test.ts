import { reconcileChoiceIds } from '../reconcile-choice-ids.js';
import type { Choice, StoryGraph, StoryNode } from '../../types.js';

// Re-uploading Ink/Twee source mints a brand-new randomUUID() for
// every choice — reconcileChoiceIds is the fix that lets per-choice
// audio (addressed by a choice's stable id) survive a re-upload
// instead of silently disappearing (found in a full-PR review).

function choice(over: Partial<Choice> = {}): Choice {
  return {
    text: 'Go',
    target: 'next',
    sticky: false,
    fallback: false,
    tags: [],
    ...over,
  };
}

function node(choices: Choice[]): StoryNode {
  return {
    id: 'start',
    type: 'knot',
    parent: null,
    content: [],
    choices,
    divert: null,
    tags: [],
    lineNumber: 1,
  };
}

function graph(nodes: Record<string, StoryNode>): StoryGraph {
  return {
    id: 'g1',
    title: 'T',
    nodes,
    startNode: Object.keys(nodes)[0],
    validation: { valid: true, errors: [], warnings: [] },
  };
}

describe('reconcileChoiceIds', () => {
  it('is a no-op when there is no previous graph (first upload)', () => {
    const newGraph = graph({ start: node([choice({ id: 'new-1' })]) });
    reconcileChoiceIds(undefined, newGraph);
    expect(newGraph.nodes.start.choices[0].id).toBe('new-1');
  });

  it('carries the old id forward for an unchanged choice (byte-identical re-upload)', () => {
    const oldGraph = graph({ start: node([choice({ id: 'old-1', text: 'Go', target: 'next' })]) });
    const newGraph = graph({
      start: node([choice({ id: 'fresh-random-1', text: 'Go', target: 'next' })]),
    });
    reconcileChoiceIds(oldGraph, newGraph);
    expect(newGraph.nodes.start.choices[0].id).toBe('old-1');
  });

  it('matches by target when the choice text was edited', () => {
    const oldGraph = graph({
      start: node([choice({ id: 'old-1', text: 'Go north', target: 'cave' })]),
    });
    const newGraph = graph({
      start: node([choice({ id: 'fresh-1', text: 'Head north', target: 'cave' })]),
    });
    reconcileChoiceIds(oldGraph, newGraph);
    expect(newGraph.nodes.start.choices[0].id).toBe('old-1');
  });

  it('matches by position as a last resort when both text and target changed', () => {
    const oldGraph = graph({
      start: node([choice({ id: 'old-1', text: 'Go north', target: 'cave' })]),
    });
    const newGraph = graph({
      start: node([choice({ id: 'fresh-1', text: 'Go south', target: 'beach' })]),
    });
    reconcileChoiceIds(oldGraph, newGraph);
    expect(newGraph.nodes.start.choices[0].id).toBe('old-1');
  });

  it('keeps a brand-new choice’s fresh id when there is nothing left to match it to', () => {
    const oldGraph = graph({ start: node([choice({ id: 'old-1' })]) });
    const newGraph = graph({
      start: node([
        choice({ id: 'fresh-1', text: 'Go', target: 'next' }),
        choice({ id: 'fresh-2', text: 'Stay', target: 'here' }),
      ]),
    });
    reconcileChoiceIds(oldGraph, newGraph);
    expect(newGraph.nodes.start.choices[0].id).toBe('old-1');
    expect(newGraph.nodes.start.choices[1].id).toBe('fresh-2');
  });

  it('drops an id with no corresponding fresh choice rather than reassigning it elsewhere', () => {
    const oldGraph = graph({
      start: node([
        choice({ id: 'old-1', text: 'Go', target: 'next' }),
        choice({ id: 'old-2', text: 'Stay', target: 'here' }),
      ]),
    });
    const newGraph = graph({
      start: node([choice({ id: 'fresh-1', text: 'Go', target: 'next' })]),
    });
    reconcileChoiceIds(oldGraph, newGraph);
    expect(newGraph.nodes.start.choices).toHaveLength(1);
    expect(newGraph.nodes.start.choices[0].id).toBe('old-1');
  });

  it('reorders without losing ids, matching by (target, text) regardless of array position', () => {
    const oldGraph = graph({
      start: node([
        choice({ id: 'old-a', text: 'Go', target: 'a' }),
        choice({ id: 'old-b', text: 'Go', target: 'b' }),
      ]),
    });
    const newGraph = graph({
      start: node([
        choice({ id: 'fresh-b', text: 'Go', target: 'b' }),
        choice({ id: 'fresh-a', text: 'Go', target: 'a' }),
      ]),
    });
    reconcileChoiceIds(oldGraph, newGraph);
    expect(newGraph.nodes.start.choices[0].id).toBe('old-b');
    expect(newGraph.nodes.start.choices[1].id).toBe('old-a');
  });

  it('does not reconcile a node that no longer exists under the same id (renamed knot)', () => {
    const oldGraph = graph({ start: node([choice({ id: 'old-1' })]) });
    const newGraph = graph({ renamed: node([choice({ id: 'fresh-1' })]) });
    reconcileChoiceIds(oldGraph, newGraph);
    expect(newGraph.nodes.renamed.choices[0].id).toBe('fresh-1');
  });

  it('does not reuse the same old id for two different new choices', () => {
    const oldGraph = graph({ start: node([choice({ id: 'old-1', text: 'Go', target: 'next' })]) });
    const newGraph = graph({
      start: node([
        choice({ id: 'fresh-1', text: 'Go', target: 'next' }),
        choice({ id: 'fresh-2', text: 'Go', target: 'next' }),
      ]),
    });
    reconcileChoiceIds(oldGraph, newGraph);
    const ids = newGraph.nodes.start.choices.map((c) => c.id);
    expect(ids).toEqual(['old-1', 'fresh-2']);
  });

  it('skips reconciling against an old choice that has no id itself (pre-rollout data)', () => {
    const oldGraph = graph({
      start: node([choice({ id: undefined, text: 'Go', target: 'next' })]),
    });
    const newGraph = graph({
      start: node([choice({ id: 'fresh-1', text: 'Go', target: 'next' })]),
    });
    reconcileChoiceIds(oldGraph, newGraph);
    expect(newGraph.nodes.start.choices[0].id).toBe('fresh-1');
  });
});
