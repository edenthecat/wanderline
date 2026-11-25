// DEV-199 stable-id rollout: the compiled-.ink.json upload path
// (parseInkJson) builds TextBlock/Choice objects independently of the
// plain-.ink path (ink-parser.ts) — a separate construction site that
// needs its own id generation, confirmed missed by code review of the
// commit that added ids everywhere else.

import { describe, expect, it } from '@jest/globals';
import { parseInkJson } from '../ink-json-parser.js';
import { isTextBlock } from '../../types.js';

function inkJson(root: unknown[]): string {
  return JSON.stringify({ inkVersion: 21, root: [root, null, {}], listDefs: {} });
}

describe('parseInkJson — stable ids', () => {
  it('assigns an id to a text block (mid-content \\n flush)', () => {
    const graph = parseInkJson(inkJson(['^Hello.', '\n', '^Bye.', '\n']), 'story-1');
    const node = graph.nodes[graph.startNode];
    const [block] = node.content;
    expect(isTextBlock(block)).toBe(true);
    expect(typeof block.id).toBe('string');
    expect(block.id).toBeTruthy();
  });

  it('assigns an id to the trailing text block (end-of-content flush)', () => {
    const graph = parseInkJson(inkJson(['^Only line, no trailing newline.']), 'story-1');
    const node = graph.nodes[graph.startNode];
    const [block] = node.content;
    expect(isTextBlock(block)).toBe(true);
    expect(block.id).toBeTruthy();
  });

  it('assigns an id to a choice', () => {
    const graph = parseInkJson(inkJson([{ 'c-0': [{ '->': 'END' }] }]), 'story-1');
    const node = graph.nodes[graph.startNode];
    expect(node.choices).toHaveLength(1);
    expect(node.choices[0].id).toBeTruthy();
  });

  it('gives every block/choice a distinct id', () => {
    const graph = parseInkJson(
      inkJson(['^A.', '\n', '^B.', '\n', { 'c-0': [{ '->': 'END' }] }]),
      'story-1',
    );
    const node = graph.nodes[graph.startNode];
    const ids = [...node.content.map((c) => c.id), ...node.choices.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
