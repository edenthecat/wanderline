// Heavy-test ladder for the phase 3 Y.Doc <-> story_graph
// JSON converter. Mismatch between seed and materialize is the
// nightmare scenario — a build derived from a stale snapshot could
// ship the wrong story content. Pin every field shape the parser
// produces.

import * as Y from 'yjs';
import { seedYDocFromStoryGraph, materializeNodesFromYDoc } from '../yjs-story.js';
import type { StoryGraph } from '../../types.js';

function baseGraph(): StoryGraph {
  return {
    id: 'test-graph',
    title: 'Test',
    startNode: 'start',
    validation: { valid: true, errors: [], warnings: [] },
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        parent: null,
        content: [
          { text: 'Welcome to the story.', tags: [] },
          { text: 'Pick wisely.', tags: ['narrator:slow'] },
        ],
        choices: [
          { text: 'Go left', target: 'left', sticky: false, fallback: false, tags: [] },
          {
            text: 'Go right',
            target: 'right',
            sticky: true,
            fallback: false,
            tags: ['important'],
          },
        ],
        divert: null,
        tags: [],
        lineNumber: 1,
      },
      left: {
        id: 'left',
        type: 'knot',
        parent: null,
        content: [{ text: 'You went left.', tags: [] }],
        choices: [],
        divert: 'END',
        tags: ['theme:blue'],
        lineNumber: 10,
        audio: { voiceover: 'left.mp3' },
      },
      right: {
        id: 'right',
        type: 'knot',
        parent: null,
        content: [{ text: 'You went right.', tags: [] }],
        choices: [],
        divert: 'END',
        tags: [],
        lineNumber: 20,
      },
    },
  };
}

describe('yjs-story converter', () => {
  it('round-trips a non-trivial story graph exactly', () => {
    const doc = new Y.Doc();
    const graph = baseGraph();
    seedYDocFromStoryGraph(doc, graph);
    const out = materializeNodesFromYDoc(doc);
    expect(out).toEqual(graph.nodes);
  });

  it('preserves audio assignments when present', () => {
    const doc = new Y.Doc();
    const graph = baseGraph();
    seedYDocFromStoryGraph(doc, graph);
    const out = materializeNodesFromYDoc(doc);
    expect(out.left.audio).toEqual({ voiceover: 'left.mp3' });
    expect(out.right.audio).toBeUndefined();
  });

  it('seed is idempotent: a second call against a populated doc is a no-op', () => {
    const doc = new Y.Doc();
    const graph = baseGraph();
    seedYDocFromStoryGraph(doc, graph);

    // Mutate one Y.Text so we can detect if seed clobbered it.
    const nodes = doc.getMap('nodes') as unknown as Y.Map<Y.Map<unknown>>;
    const startContent = (nodes.get('start') as Y.Map<unknown>).get('content') as Y.Array<
      Y.Map<unknown>
    >;
    const firstItem = startContent.get(0) as Y.Map<unknown>;
    (firstItem.get('text') as Y.Text).delete(0, (firstItem.get('text') as Y.Text).length);
    (firstItem.get('text') as Y.Text).insert(0, 'MUTATED');

    // Second seed must not overwrite the mutation.
    seedYDocFromStoryGraph(doc, graph);
    const out = materializeNodesFromYDoc(doc);
    expect(out.start.content[0].text).toBe('MUTATED');
  });

  it('character-level concurrent edits to a choice text merge cleanly', () => {
    // Simulate two clients editing the same choice text in
    // parallel. We use two separate Y.Docs + apply each other's
    // update vectors so the operation matches what the live
    // collab server would relay.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const graph = baseGraph();
    seedYDocFromStoryGraph(docA, graph);

    // Replicate state A → B.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    function getChoiceText(d: Y.Doc): Y.Text {
      const nodes = d.getMap('nodes') as unknown as Y.Map<Y.Map<unknown>>;
      const choices = (nodes.get('start') as Y.Map<unknown>).get('choices') as Y.Array<
        Y.Map<unknown>
      >;
      return (choices.get(0) as Y.Map<unknown>).get('text') as Y.Text;
    }

    const choiceA = getChoiceText(docA);
    const choiceB = getChoiceText(docB);

    // A and B both insert at different offsets concurrently.
    // Initial text is "Go left"; A prepends "*", B appends "!".
    choiceA.insert(0, '*');
    choiceB.insert(choiceB.length, '!');

    // Exchange updates.
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

    // Both clients converge on the same string.
    expect(choiceA.toString()).toBe(choiceB.toString());
    expect(choiceA.toString()).toBe('*Go left!');
  });

  it('handles an empty story graph (no nodes) without crashing', () => {
    const doc = new Y.Doc();
    seedYDocFromStoryGraph(doc, {
      id: 'empty',
      title: '',
      startNode: '',
      nodes: {},
      validation: { valid: true, errors: [], warnings: [] },
    });
    expect(materializeNodesFromYDoc(doc)).toEqual({});
  });
});
