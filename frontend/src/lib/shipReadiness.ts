// "Can I ship this?" — the five signals the editor already computes,
// collected into one answer.
//
// Nothing here is new analysis. Every count is lifted verbatim from
// the surface that already owns it, so the summary and the panel it
// links to can never disagree:
//
//   parser errors        story_graph.validation.errors   ValidationPanel
//   unresolved flags     GET /projects/:id/flags .total  FlaggedNodesPanel
//   unreachable nodes    computeStoryHealth()            StoryHealthPanel
//   nodes unvoiced       .../audio/coverage              AudioTab's "Nodes
//                        .nodesWithoutAudio              without voiceover"
//   audio disagreements  .../audio/assignments/audit     AssignmentAuditPanel
//                        .disagreements
//
// "Node", not the knot/passage vocab skin, is deliberate. Both counts
// span knots AND stitches — computeStoryHealth walks every id, and
// /audio/coverage keys off Object.keys(story_graph.nodes) — so calling
// them knots would overstate them for any Ink story with stitches.
// StoryHealthPanel ("N nodes", "Unreachable nodes"), AudioTab ("Nodes
// without voiceover") and StoryTab's own stat row all use the same
// unskinned word for the same universe, which is the point.
//
// Two of those are deliberate choices, not defaults:
//
// 1. Parser errors come from the STORED validation blob, which the
//    backend computed against the story as uploaded — before
//    normalizeStoryGraph qualified bare stitch targets on read. Nothing
//    re-validates on read, so the blob can name a `missing_target` that
//    the in-app graph resolves fine. That is exactly what ValidationPanel
//    shows, so it is exactly what this counts: a summary that quietly
//    filtered obsolete rows would send the author to a panel listing
//    more errors than the badge that sent them there.
//
// 2. Unreachable nodes come from computeStoryHealth, walking the
//    normalized graph — NOT from the blob's `unreachable_node` warnings,
//    which are the backend's own pre-qualification reachability pass.
//    The two genuinely differ (storyHealth also synthesizes Ink knot /
//    stitch fall-through, which the backend does not), and the panel an
//    author lands on for this count is StoryHealthPanel.
//
// The backend also has GET /projects/:id/validate, a sixth
// implementation of most of this. It is deliberately unused here: no
// panel in the editor renders it, so its numbers answer to nothing the
// author can click through to.

import type { StoryGraph } from '../api/client';
import { PANEL_ANCHORS } from './panelAnchors';
import { computeStoryHealth } from './storyHealth';

export type ReadinessSeverity = 'blocking' | 'review';

export type ReadinessCheckId =
  | 'parser_errors'
  | 'open_flags'
  | 'unreachable_nodes'
  | 'nodes_without_voiceover'
  | 'assignment_disagreements';

/** Where the panel that owns a count lives. `tab` is a member of
 * ProjectDetailPage's `Tab` union; `anchorId` is the `id` on that
 * panel's root element. */
export interface ReadinessTarget {
  tab: 'story' | 'audio';
  anchorId: string;
}

export interface ReadinessCheck {
  id: ReadinessCheckId;
  /** Headline text, already pluralized against `count`. */
  label: string;
  /** One line on why it matters. */
  detail: string;
  /** `null` when the lookup behind it failed — reported as unknown
   * rather than folded into zero, because "we could not check" and
   * "there is nothing wrong" are opposite answers to "can I ship?". */
  count: number | null;
  severity: ReadinessSeverity;
  target: ReadinessTarget;
}

export interface ReadinessInputs {
  /** The normalized graph from fetchProject. */
  storyGraph: StoryGraph | null;
  /** `fetchNodeFlags(...).total` — the true open count, which can
   * exceed the page FlaggedNodesPanel lists (the panel says so). */
  openFlagCount: number | null;
  /** `fetchAudioCoverage(...).nodesWithoutAudio.length`. */
  nodesWithoutVoiceover: number | null;
  /** `auditAudioAssignments(...).disagreements.length`. */
  assignmentDisagreements: number | null;
}

export interface ReadinessSummary {
  /** All five, in display order, zero counts included. */
  checks: ReadinessCheck[];
  /** Non-zero and blocking: the build itself is compromised. */
  blocking: ReadinessCheck[];
  /** Non-zero but shippable: someone should still look. */
  review: ReadinessCheck[];
  /** Lookup failed — we genuinely do not know. */
  unknown: ReadinessCheck[];
  /** 'ready' is only claimed when there is a story, every check
   * answered, and every one answered zero. */
  status: 'blocked' | 'empty' | 'review' | 'unknown' | 'ready';
  /** Node count, from the same walk the unreachable count comes from,
   * so the all-clear line can say something concrete. */
  totalNodes: number;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Collect the five counts into one answer. Pure, but it runs
 * computeStoryHealth's BFS — call it inside a useMemo keyed on the
 * inputs rather than per render.
 */
export function computeReadiness(inputs: ReadinessInputs): ReadinessSummary {
  const { storyGraph } = inputs;
  const health = computeStoryHealth(storyGraph);
  // No story at all leaves both graph-derived counts genuinely
  // unknown rather than zero — an empty project is not a clean one.
  //
  // `validation` is typed as required but comes from a JSONB column
  // written by whatever parser version was current at upload, so it is
  // read defensively: a stored graph without the blob should report
  // "couldn't check", not take the Ship tab down with it.
  const parserErrors = Array.isArray(storyGraph?.validation?.errors)
    ? storyGraph.validation.errors.length
    : null;
  const unreachable = storyGraph ? health.unreachableNodes.length : null;

  const checks: ReadinessCheck[] = [
    {
      id: 'parser_errors',
      label:
        parserErrors === null
          ? 'Parser errors'
          : plural(parserErrors, 'parser error', 'parser errors'),
      detail:
        'The story file did not parse cleanly. A build made from it is broken wherever the parser gave up.',
      count: parserErrors,
      severity: 'blocking',
      target: { tab: 'story', anchorId: PANEL_ANCHORS.validation },
    },
    {
      id: 'open_flags',
      label:
        inputs.openFlagCount === null
          ? 'Unresolved flags'
          : plural(inputs.openFlagCount, 'unresolved flag', 'unresolved flags'),
      detail: 'Someone reported a problem on these nodes and nobody has closed it out yet.',
      count: inputs.openFlagCount,
      severity: 'review',
      target: { tab: 'story', anchorId: PANEL_ANCHORS.flaggedNodes },
    },
    {
      id: 'unreachable_nodes',
      label:
        unreachable === null
          ? 'Unreachable nodes'
          : plural(unreachable, 'unreachable node', 'unreachable nodes'),
      detail:
        'Written, but nothing in the story leads to them. They ship, and no listener ever hears them.',
      count: unreachable,
      severity: 'review',
      target: { tab: 'story', anchorId: PANEL_ANCHORS.storyHealth },
    },
    {
      id: 'nodes_without_voiceover',
      label:
        inputs.nodesWithoutVoiceover === null
          ? 'Nodes with no voiceover'
          : plural(
              inputs.nodesWithoutVoiceover,
              'node with no voiceover',
              'nodes with no voiceover',
            ),
      detail: 'No voiceover clip is assigned, so the listener reaches these in silence.',
      count: inputs.nodesWithoutVoiceover,
      severity: 'review',
      target: { tab: 'audio', anchorId: PANEL_ANCHORS.missingVoiceover },
    },
    {
      id: 'assignment_disagreements',
      label:
        inputs.assignmentDisagreements === null
          ? 'Audio assignments to review'
          : plural(
              inputs.assignmentDisagreements,
              'clip whose filename disagrees',
              'clips whose filenames disagree',
            ),
      detail:
        'Their filename points at a different node than the one they sit on. Often deliberate — worth confirming before it ships.',
      count: inputs.assignmentDisagreements,
      severity: 'review',
      target: { tab: 'audio', anchorId: PANEL_ANCHORS.assignmentAudit },
    },
  ];

  const blocking: ReadinessCheck[] = [];
  const review: ReadinessCheck[] = [];
  const unknown: ReadinessCheck[] = [];
  for (const check of checks) {
    if (check.count === null) unknown.push(check);
    else if (check.count === 0) continue;
    else if (check.severity === 'blocking') blocking.push(check);
    else review.push(check);
  }

  // Precedence: a real finding outranks an unanswered lookup in the
  // headline — it is actionable now, and the unknowns are listed
  // either way. An unanswered lookup in turn outranks 'ready', because
  // we have no basis for the all-clear.
  //
  // A story with no nodes sits just under 'blocked': every check
  // trivially answers zero, so without this the Ship tab would put
  // "Ready to ship — nothing to fix across 0 nodes" directly above the
  // Build button. Below 'blocked' because a file that failed to parse
  // hard enough to yield no nodes at all is better described by its
  // errors. StoryHealthPanel refuses to render at all in this case,
  // for the same reason.
  const status: ReadinessSummary['status'] = blocking.length
    ? 'blocked'
    : health.totalNodes === 0
      ? 'empty'
      : review.length
        ? 'review'
        : unknown.length
          ? 'unknown'
          : 'ready';

  return { checks, blocking, review, unknown, status, totalNodes: health.totalNodes };
}
