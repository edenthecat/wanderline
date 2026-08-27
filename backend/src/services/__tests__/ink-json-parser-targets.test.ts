// Bare stitch targets on the compiled-.ink.json upload path.
//
// The two upload routes must agree on what `-> actual_credits` inside
// `== credits ==` means, or the same story resolves differently
// depending on which format it was uploaded in. This path had no tests
// at all before.

import { describe, expect, it } from '@jest/globals';
import { parseInkJson } from '../ink-json-parser.js';

/**
 * Minimal compiled-Ink shape: `root` is [rootContent, ..., namedContent].
 * A knot is a container whose last element names it with `#n` and holds
 * any stitches as nested named containers.
 */
function inkJson(named: Record<string, unknown>): string {
  return JSON.stringify({
    inkVersion: 21,
    root: [['^Start.', '\n', { '->': 'credits' }, null], null, named],
    listDefs: {},
  });
}

const stitch = (name: string, body: unknown[]) => [body, { '#n': name }];

describe('parseInkJson bare stitch targets', () => {
  const withStitch = inkJson({
    credits: [
      ['^Thanks.', '\n', { '->': 'actual_credits' }, null],
      {
        actual_credits: stitch('actual_credits', ['^Written for testing.', '\n', { '->': 'END' }]),
        '#n': 'credits',
      },
    ],
  });

  it("qualifies a bare divert against its own knot's stitch", () => {
    const graph = parseInkJson(withStitch, 'story-1');
    expect(graph.nodes['credits']?.divert).toBe('credits.actual_credits');
  });

  it('leaves every target naming a real node', () => {
    const graph = parseInkJson(withStitch, 'story-2');
    const dangling: string[] = [];
    for (const [id, node] of Object.entries(graph.nodes)) {
      const targets = [...(node.choices ?? []).map((c) => c.target), node.divert].filter(
        (t): t is string => !!t && t !== 'END' && t !== 'DONE',
      );
      for (const t of targets) if (!graph.nodes[t]) dangling.push(`${id} -> ${t}`);
    }
    expect(dangling).toEqual([]);
  });

  it('leaves a target that names nothing alone', () => {
    const graph = parseInkJson(
      inkJson({
        credits: [['^Thanks.', '\n', { '->': 'nowhere_at_all' }, null], { '#n': 'credits' }],
      }),
      'story-3',
    );
    // Rewriting it would hide a real broken link behind a plausible id;
    // validateGraph is what reports it.
    expect(graph.nodes['credits']?.divert).toBe('nowhere_at_all');
  });
});
