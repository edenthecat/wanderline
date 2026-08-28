import { describe, expect, it } from 'vitest';
import type { StoryGraph, StoryNode, ValidationMessage } from '../../api/client';
import { computeReadiness, type ReadinessCheckId } from '../shipReadiness';
import { PANEL_ANCHORS } from '../panelAnchors';

function node(id: string, over: Partial<StoryNode> = {}): StoryNode {
  return {
    id,
    type: 'knot',
    parent: null,
    content: [],
    choices: [],
    divert: null,
    tags: [],
    lineNumber: 1,
    ...over,
  };
}

function graph(nodes: StoryNode[], validation: Partial<StoryGraph['validation']> = {}): StoryGraph {
  return {
    id: 'g1',
    title: 'Story',
    startNode: nodes[0]?.id ?? '',
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    validation: { valid: true, errors: [], warnings: [], ...validation },
  };
}

const clean = {
  openFlagCount: 0,
  nodesWithoutVoiceover: 0,
  assignmentDisagreements: 0,
};

function countOf(
  summary: ReturnType<typeof computeReadiness>,
  id: ReadinessCheckId,
): number | null {
  return summary.checks.find((c) => c.id === id)!.count;
}

const err = (over: Partial<ValidationMessage> = {}): ValidationMessage => ({
  type: 'missing_target',
  message: 'intro diverts to a target that does not exist',
  ...over,
});

describe('computeReadiness', () => {
  // The stored validation blob is the backend's, computed against the
  // story as uploaded — BEFORE normalizeStoryGraph qualified bare
  // stitch targets on read. Nothing re-validates on read, so a blob
  // error can name a target the in-app graph resolves fine. That is
  // what ValidationPanel shows, so it is what the summary must count:
  // recomputing here would send the author to a panel listing errors
  // the badge said were gone.
  it('counts parser errors from the stored blob, not from the normalized graph', () => {
    const g = graph(
      [
        // `-> reply` was written bare inside `inbox` and has already
        // been qualified to `inbox.reply` by normalizeStoryGraph, so a
        // fresh walk of THIS graph would find nothing wrong.
        node('inbox', { divert: 'inbox.reply' }),
        node('inbox.reply', { type: 'stitch', parent: 'inbox', lineNumber: 2, divert: 'END' }),
      ],
      {
        valid: false,
        errors: [err({ nodeId: 'inbox', message: 'inbox diverts to unknown reply' })],
      },
    );
    const summary = computeReadiness({ storyGraph: g, ...clean });
    expect(countOf(summary, 'parser_errors')).toBe(1);
  });

  it('does not count validation warnings as parser errors', () => {
    const g = graph([node('start', { divert: 'END' })], {
      warnings: [err({ type: 'empty_node', message: 'start has no content' })],
    });
    const summary = computeReadiness({ storyGraph: g, ...clean });
    expect(countOf(summary, 'parser_errors')).toBe(0);
    expect(summary.status).toBe('ready');
  });

  // The blob's own `unreachable_node` warnings are the backend's
  // pre-qualification reachability pass, and StoryHealthPanel — the
  // panel this count links to — ignores them in favour of
  // computeStoryHealth. The summary follows the panel.
  it('takes unreachable nodes from story health, not the blob’s unreachable warnings', () => {
    const g = graph(
      [
        node('start', { divert: 'middle' }),
        node('middle', { divert: 'END' }),
        node('lonely', { divert: 'END' }),
      ],
      {
        warnings: [
          { type: 'unreachable_node', message: 'middle is unreachable', nodeId: 'middle' },
          { type: 'unreachable_node', message: 'lonely is unreachable', nodeId: 'lonely' },
        ],
      },
    );
    const summary = computeReadiness({ storyGraph: g, ...clean });
    // Two warnings on the blob; only `lonely` is genuinely orphaned.
    expect(countOf(summary, 'unreachable_nodes')).toBe(1);
  });

  // computeStoryHealth synthesizes Ink's knot -> first-stitch
  // fall-through, which the parser never materializes as a divert. A
  // naive re-implementation over choices + diverts alone would call
  // `inbox.reply` unreachable, and the summary would then contradict
  // the panel it links to.
  it('honours Ink knot fall-through when counting unreachable nodes', () => {
    const g = graph([
      node('inbox'),
      node('inbox.reply', { type: 'stitch', parent: 'inbox', lineNumber: 2, divert: 'END' }),
    ]);
    const summary = computeReadiness({ storyGraph: g, ...clean });
    expect(countOf(summary, 'unreachable_nodes')).toBe(0);
    expect(summary.status).toBe('ready');
  });

  it('separates what blocks a ship from what merely wants a look', () => {
    const g = graph([node('start', { divert: 'END' }), node('lonely', { divert: 'END' })], {
      valid: false,
      errors: [err(), err()],
    });
    const summary = computeReadiness({
      storyGraph: g,
      openFlagCount: 3,
      nodesWithoutVoiceover: 7,
      assignmentDisagreements: 1,
    });
    expect(summary.status).toBe('blocked');
    expect(summary.blocking.map((c) => c.id)).toEqual(['parser_errors']);
    expect(summary.review.map((c) => c.id)).toEqual([
      'open_flags',
      'unreachable_nodes',
      'nodes_without_voiceover',
      'assignment_disagreements',
    ]);
    expect(summary.unknown).toHaveLength(0);
  });

  it('leaves zero-count checks out of every group', () => {
    const g = graph([node('start', { divert: 'END' })]);
    const summary = computeReadiness({
      storyGraph: g,
      openFlagCount: 0,
      nodesWithoutVoiceover: 2,
      assignmentDisagreements: 0,
    });
    expect(summary.status).toBe('review');
    expect(summary.review.map((c) => c.id)).toEqual(['nodes_without_voiceover']);
    expect(summary.blocking).toHaveLength(0);
  });

  it('reports a clean story as ready, with a node count to say so', () => {
    const g = graph([node('start', { divert: 'ending' }), node('ending', { divert: 'END' })]);
    const summary = computeReadiness({ storyGraph: g, ...clean });
    expect(summary.status).toBe('ready');
    expect(summary.totalNodes).toBe(2);
  });

  // Both counts span knots AND stitches, so the knot/passage vocab
  // skin would overstate them. "Node" is the word StoryHealthPanel and
  // AudioTab already use for this exact universe — matching them is
  // the whole point of the module.
  it('names nodes the way the panels it links to name them', () => {
    const g = graph([
      node('inbox'),
      node('inbox.reply', { type: 'stitch', parent: 'inbox', lineNumber: 2, divert: 'END' }),
      node('lonely', { divert: 'END' }),
    ]);
    const summary = computeReadiness({
      storyGraph: g,
      openFlagCount: 0,
      nodesWithoutVoiceover: 2,
      assignmentDisagreements: 0,
    });
    expect(summary.review.map((c) => c.label)).toEqual([
      '1 unreachable node',
      '2 nodes with no voiceover',
    ]);
  });

  // Every check trivially answers zero on a story with no nodes, so
  // without a guard the Ship tab would put "Ready to ship" directly
  // above the Build button for a project with nothing in it.
  it('never calls an empty story ready', () => {
    const summary = computeReadiness({ storyGraph: graph([]), ...clean });
    expect(summary.status).toBe('empty');
    expect(summary.totalNodes).toBe(0);
  });

  // A file that failed to parse hard enough to produce no nodes is
  // better described by its errors than by its emptiness.
  it('leads with parser errors on a story that parsed to nothing', () => {
    const summary = computeReadiness({
      storyGraph: graph([], { valid: false, errors: [err()] }),
      ...clean,
    });
    expect(summary.status).toBe('blocked');
  });

  // "We could not check" and "there is nothing wrong" are opposite
  // answers to "can I ship?", so a failed lookup must never collapse
  // into a zero — and must never let the all-clear be claimed.
  it('reports a failed lookup as unknown rather than as zero', () => {
    const g = graph([node('start', { divert: 'END' })]);
    const summary = computeReadiness({
      storyGraph: g,
      openFlagCount: null,
      nodesWithoutVoiceover: 0,
      assignmentDisagreements: 0,
    });
    expect(summary.status).toBe('unknown');
    expect(summary.unknown.map((c) => c.id)).toEqual(['open_flags']);
    expect(countOf(summary, 'open_flags')).toBeNull();
  });

  it('still leads with a real finding when another lookup failed', () => {
    const g = graph([node('start', { divert: 'END' })], { valid: false, errors: [err()] });
    const summary = computeReadiness({
      storyGraph: g,
      openFlagCount: null,
      nodesWithoutVoiceover: 0,
      assignmentDisagreements: 0,
    });
    expect(summary.status).toBe('blocked');
    expect(summary.unknown.map((c) => c.id)).toEqual(['open_flags']);
  });

  // An empty project is not a clean one: with no graph there is
  // nothing to have validated or walked, so neither graph-derived
  // count can answer — and the headline is that there is nothing here
  // yet, never that it is ready.
  it('treats a project with no story as unchecked, not as ready', () => {
    const summary = computeReadiness({ storyGraph: null, ...clean });
    expect(summary.status).toBe('empty');
    expect(summary.unknown.map((c) => c.id)).toEqual(['parser_errors', 'unreachable_nodes']);
  });

  it('points each count at the panel that owns it', () => {
    const g = graph([node('start', { divert: 'END' })]);
    const byId = Object.fromEntries(
      computeReadiness({ storyGraph: g, ...clean }).checks.map((c) => [c.id, c.target]),
    );
    expect(byId.parser_errors).toEqual({ tab: 'story', anchorId: PANEL_ANCHORS.validation });
    expect(byId.open_flags).toEqual({ tab: 'story', anchorId: PANEL_ANCHORS.flaggedNodes });
    expect(byId.unreachable_nodes).toEqual({
      tab: 'story',
      anchorId: PANEL_ANCHORS.storyHealth,
    });
    expect(byId.nodes_without_voiceover).toEqual({
      tab: 'audio',
      anchorId: PANEL_ANCHORS.missingVoiceover,
    });
    expect(byId.assignment_disagreements).toEqual({
      tab: 'audio',
      anchorId: PANEL_ANCHORS.assignmentAudit,
    });
  });

  it('pluralizes each label against its own count', () => {
    const g = graph([node('start', { divert: 'END' })], { valid: false, errors: [err()] });
    const one = computeReadiness({
      storyGraph: g,
      openFlagCount: 1,
      nodesWithoutVoiceover: 0,
      assignmentDisagreements: 0,
    });
    expect(one.blocking[0].label).toBe('1 parser error');
    expect(one.review[0].label).toBe('1 unresolved flag');

    const many = computeReadiness({
      storyGraph: graph([node('start', { divert: 'END' })], {
        valid: false,
        errors: [err(), err()],
      }),
      openFlagCount: 4,
      nodesWithoutVoiceover: 0,
      assignmentDisagreements: 0,
    });
    expect(many.blocking[0].label).toBe('2 parser errors');
    expect(many.review[0].label).toBe('4 unresolved flags');
  });
});
