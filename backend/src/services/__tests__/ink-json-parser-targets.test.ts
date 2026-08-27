// Divert-target resolution on the compiled-.ink.json upload path.
//
// This path had no tests at all, which is how a regression got in:
// resolving *any* relative target meant compiler-internal paths
// (`.^.^.2`, `.^.0.g-0`) became ids like `credits.2` that name nothing
// — and because the first `->` in a content array wins, that invented
// target displaced the real divert that followed it.

import { describe, expect, it } from '@jest/globals';
import { parseInkJson } from '../ink-json-parser.js';

/**
 * Minimal compiled-Ink shape: `root` is [rootContent, ..., namedContent].
 * Each knot is a container whose last element carries `#n` (its name)
 * and any stitches as nested named containers.
 */
function inkJson(named: Record<string, unknown>): string {
  return JSON.stringify({
    inkVersion: 21,
    root: [['^Start.', '\n', { '->': 'credits' }, null], null, named],
    listDefs: {},
  });
}

describe('parseInkJson divert targets', () => {
  it('resolves a relative divert to the enclosing knot stitch', () => {
    const graph = parseInkJson(
      inkJson({
        credits: [
          ['^Thanks.', '\n', { '->': '.^.^.actual_credits' }, null],
          {
            actual_credits: ['^Written for testing.', '\n', { '->': 'END' }, null],
            '#n': 'credits',
          },
        ],
      }),
      'story-1',
    );
    expect(graph.nodes['credits']?.divert).toBe('credits.actual_credits');
  });

  it('does not invent a target from a container index', () => {
    // `.^.^.2` points at a container by position, not a passage. Turning
    // it into `credits.2` produced a phantom missing_target AND, because
    // the first divert wins, dropped the real one on the next line.
    const graph = parseInkJson(
      inkJson({
        credits: [
          ['^Thanks.', '\n', { '->': '.^.^.2' }, { '->': 'ending' }, null],
          { '#n': 'credits' },
        ],
        ending: [['^Done.', '\n', { '->': 'END' }, null], { '#n': 'ending' }],
      }),
      'story-2',
    );
    expect(graph.nodes['credits']?.divert).toBe('ending');
    const missing = graph.validation.warnings.filter((w) => w.type === 'missing_target');
    expect(missing).toEqual([]);
  });

  it('does not invent a target from a generated container name', () => {
    const graph = parseInkJson(
      inkJson({
        credits: [
          ['^Thanks.', '\n', { '->': '.^.0.g-0' }, { '->': 'ending' }, null],
          { '#n': 'credits' },
        ],
        ending: [['^Done.', '\n', { '->': 'END' }, null], { '#n': 'ending' }],
      }),
      'story-3',
    );
    expect(graph.nodes['credits']?.divert).toBe('ending');
  });

  it('leaves every target naming a real node', () => {
    const graph = parseInkJson(
      inkJson({
        credits: [
          ['^Thanks.', '\n', { '->': '.^.^.actual_credits' }, null],
          {
            actual_credits: ['^Written for testing.', '\n', { '->': 'END' }, null],
            '#n': 'credits',
          },
        ],
      }),
      'story-4',
    );
    const dangling: string[] = [];
    for (const [id, node] of Object.entries(graph.nodes)) {
      const targets = [...(node.choices ?? []).map((c) => c.target), node.divert].filter(
        (t): t is string => !!t && t !== 'END' && t !== 'DONE',
      );
      for (const t of targets) if (!graph.nodes[t]) dangling.push(`${id} -> ${t}`);
    }
    expect(dangling).toEqual([]);
  });
});
