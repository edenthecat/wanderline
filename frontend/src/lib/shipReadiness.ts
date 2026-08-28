// "Can I ship this?" — the five signals the editor already computes,
// collected into one answer.
//
// Nothing here is new analysis. Every count is lifted verbatim from
// the surface that already owns it, so the summary and the panel it
// links to can never disagree:
//
//   parser errors        story_graph.validation.errors   ValidationPanel
//   unresolved flags     GET /projects/:id/flags .total  FlaggedNodesPanel
//   unreachable passages computeStoryHealth()            StoryHealthPanel
//   passages unvoiced    .../audio/coverage              AudioTab's "Nodes
//                        .nodesWithoutAudio              without voiceover"
//   audio disagreements  .../audio/assignments/audit     AssignmentAuditPanel
//                        .disagreements
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
// 2. Unreachable passages come from computeStoryHealth, walking the
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
import type { Vocab } from './nomenclature';
import { PANEL_ANCHORS } from './panelAnchors';
import { computeStoryHealth } from './storyHealth';

export type ReadinessSeverity = 'blocking' | 'review';

export type ReadinessCheckId =
  | 'parser_errors'
  | 'open_flags'
  | 'unreachable_passages'
  | 'passages_without_voiceover'
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
  passagesWithoutVoiceover: number | null;
  /** `auditAudioAssignments(...).disagreements.length`. */
  assignmentDisagreements: number | null;
  /** `useVocab(...).node` — "knot" for an Ink project, "passage" for
   * Twee. Copy here must not hard-code either (see lib/nomenclature):
   * a Ship tab reporting "3 unreachable passages" while the panel it
   * links to calls them knots is the same disagreement this module
   * exists to prevent, one level up. */
  nodeNoun: Vocab['node'];
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
  /** 'ready' is only claimed when every check answered, and answered zero. */
  status: 'blocked' | 'review' | 'unknown' | 'ready';
  /** Node count, from the same walk the unreachable count comes from,
   * so the all-clear line can say something concrete. */
  totalNodes: number;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Collect the five counts into one answer. Pure, but it runs
 * computeStoryHealth's BFS — call it inside a useMemo keyed on the
 * inputs rather than per render.
 */
export function computeReadiness(inputs: ReadinessInputs): ReadinessSummary {
  const { storyGraph, nodeNoun } = inputs;
  const health = computeStoryHealth(storyGraph);
  // No story at all leaves both graph-derived counts genuinely
  // unknown rather than zero — an empty project is not a clean one.
  const parserErrors = storyGraph ? storyGraph.validation.errors.length : null;
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
      detail: `Someone reported a problem on ${nodeNoun.plural} here and nobody has closed it out yet.`,
      count: inputs.openFlagCount,
      severity: 'review',
      target: { tab: 'story', anchorId: PANEL_ANCHORS.flaggedNodes },
    },
    {
      id: 'unreachable_passages',
      label:
        unreachable === null
          ? `Unreachable ${nodeNoun.plural}`
          : plural(
              unreachable,
              `unreachable ${nodeNoun.singular}`,
              `unreachable ${nodeNoun.plural}`,
            ),
      detail:
        'Written, but nothing in the story leads to them. They ship, and no listener ever hears them.',
      count: unreachable,
      severity: 'review',
      target: { tab: 'story', anchorId: PANEL_ANCHORS.storyHealth },
    },
    {
      id: 'passages_without_voiceover',
      label:
        inputs.passagesWithoutVoiceover === null
          ? `${capitalize(nodeNoun.plural)} with no voiceover`
          : plural(
              inputs.passagesWithoutVoiceover,
              `${nodeNoun.singular} with no voiceover`,
              `${nodeNoun.plural} with no voiceover`,
            ),
      detail: 'No voiceover clip is assigned, so the listener reaches these in silence.',
      count: inputs.passagesWithoutVoiceover,
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
      detail: `Their filename points at a different ${nodeNoun.singular} than the one they sit on. Often deliberate — worth confirming before it ships.`,
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
  // either way. But an unanswered lookup always outranks 'ready',
  // because we have no basis for the all-clear.
  const status: ReadinessSummary['status'] = blocking.length
    ? 'blocked'
    : review.length
      ? 'review'
      : unknown.length
        ? 'unknown'
        : 'ready';

  return { checks, blocking, review, unknown, status, totalNodes: health.totalNodes };
}
