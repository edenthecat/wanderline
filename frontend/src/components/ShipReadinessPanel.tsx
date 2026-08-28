// "Can I ship this?" — answered where the author asks it.
//
// Five panels already report problems: ValidationPanel, FlaggedNodesPanel
// and StoryHealthPanel on Story; AssignmentAuditPanel and the coverage
// list on Audio. None of them live on Ship, so the author had to visit
// two tabs and hold five lists in their head to decide whether to press
// Build. This is that decision, above the Build button.
//
// It aggregates; it does not analyse. Every count comes from the source
// that already owns it — see lib/shipReadiness for which, and why the
// unreachable count deliberately follows computeStoryHealth rather than
// the stored validation blob's own reachability warnings.

import { useEffect, useMemo, useState } from 'react';
import {
  auditAudioAssignments,
  fetchAudioCoverage,
  fetchNodeFlags,
  type StoryGraph,
} from '../api/client';
import {
  computeReadiness,
  type ReadinessCheck,
  type ReadinessSummary,
  type ReadinessTarget,
} from '../lib/shipReadiness';
import { useVocab } from '../hooks/useVocab';
import type { Nomenclature, NomenclaturePreference } from '../lib/nomenclature';

interface Props {
  projectId: string;
  /** The normalized graph the page already holds — no refetch. */
  storyGraph: StoryGraph | null;
  /** Switch to the owning panel's tab and scroll to it. */
  onNavigate: (target: ReadinessTarget) => void;
  /** Terminology inputs: the summary must call a node whatever the
   * panel it links to calls it. */
  sourceLanguage: Nomenclature;
  nomenclaturePreference: NomenclaturePreference;
}

/** The three counts that need a request. `null` means the request
 * failed; the check reports "couldn't check" rather than zero. */
interface FetchedCounts {
  openFlagCount: number | null;
  passagesWithoutVoiceover: number | null;
  assignmentDisagreements: number | null;
}

const STATUS_LABEL: Record<ReadinessSummary['status'], string> = {
  blocked: 'Not ready',
  review: 'Ships, with caveats',
  unknown: 'Partly checked',
  ready: 'Ready to ship',
};

// Each check's own `detail` says why the finding matters, which is a
// claim we have no right to make about a lookup that never answered.
// The unknown group substitutes this.
const UNKNOWN_DETAIL = 'This check didn’t answer. Open the panel to look for yourself.';

function CheckRow({
  check,
  detail,
  onNavigate,
}: {
  check: ReadinessCheck;
  /** Overrides the check's own copy. */
  detail?: string;
  onNavigate: (target: ReadinessTarget) => void;
}) {
  return (
    <li className="readiness-item">
      <button
        type="button"
        className="readiness-item-button"
        onClick={() => onNavigate(check.target)}
      >
        <span className="readiness-item-label">{check.label}</span>
        <span className="readiness-item-detail">{detail ?? check.detail}</span>
      </button>
    </li>
  );
}

export default function ShipReadinessPanel({
  projectId,
  storyGraph,
  onNavigate,
  sourceLanguage,
  nomenclaturePreference,
}: Props) {
  const vocab = useVocab(sourceLanguage, nomenclaturePreference);
  const [counts, setCounts] = useState<FetchedCounts | null>(null);

  // A boolean, not the graph itself: the page silently refetches the
  // project on every child save, handing us a fresh graph object each
  // time, and depending on that identity would re-issue all three
  // requests per keystroke.
  const hasStory = !!storyGraph;
  useEffect(() => {
    // Nothing renders without a story (see the early return below), so
    // three discarded round trips — one of them a full re-match of
    // every audio assignment — would buy nothing.
    if (!hasStory) return;
    let cancelled = false;
    setCounts(null);
    // Every visit to Ship pays for a fresh audit, which re-matches
    // every attached clip server-side. Deliberate: this is the screen
    // that answers "can I ship this", and a cached count saying
    // "nothing to review" about a project someone changed ten minutes
    // ago is worse than the request. AssignmentAuditPanel stays
    // opt-in for the same reason in reverse — an ordinary visit to
    // Audio is not asking the question.
    //
    // allSettled, not all: one dead endpoint must degrade that one
    // check to "couldn't check", not blank the whole summary. A
    // readiness panel that disappears when the flags API hiccups is
    // worse than one that says which question it could not answer.
    void Promise.allSettled([
      fetchNodeFlags(projectId),
      fetchAudioCoverage(projectId),
      auditAudioAssignments(projectId),
    ]).then(([flags, coverage, audit]) => {
      if (cancelled) return;
      // allSettled covers a rejected request, not a fulfilled one whose
      // body is not the shape we expect — a proxy's own JSON error page
      // returned as 200, or a backend a version ahead. Reading through
      // it would throw here and never reach setCounts, leaving the
      // panel stuck on "Checking…": the exact outcome the allSettled
      // above exists to prevent. Fall back to all-unknown instead.
      try {
        setCounts({
          // `.total` is the true open count. FlaggedNodesPanel's own
          // badge shows the returned page and says so when the server
          // capped it; the readiness answer wants the real number.
          openFlagCount: flags.status === 'fulfilled' ? flags.value.total : null,
          passagesWithoutVoiceover:
            coverage.status === 'fulfilled' ? coverage.value.nodesWithoutAudio.length : null,
          assignmentDisagreements:
            audit.status === 'fulfilled' ? audit.value.disagreements.length : null,
        });
      } catch {
        setCounts({
          openFlagCount: null,
          passagesWithoutVoiceover: null,
          assignmentDisagreements: null,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, hasStory]);

  // computeReadiness runs computeStoryHealth's BFS; keep it off the
  // per-render path for a 500-knot story.
  const summary = useMemo(
    () =>
      counts &&
      computeReadiness({
        storyGraph,
        openFlagCount: counts.openFlagCount,
        passagesWithoutVoiceover: counts.passagesWithoutVoiceover,
        assignmentDisagreements: counts.assignmentDisagreements,
        nodeNoun: vocab.node,
      }),
    [storyGraph, counts, vocab],
  );

  // No story means nothing to be ready about, and BuildsTab directly
  // below already explains that an Ink file has to come first.
  if (!storyGraph) return null;

  return (
    <section className="readiness" data-testid="ship-readiness" aria-label="Ship readiness">
      <div className="readiness-head">
        <h2 className="readiness-title">Ready to ship?</h2>
        <span
          className={`readiness-status readiness-status-${summary ? summary.status : 'checking'}`}
          role="status"
        >
          {summary ? STATUS_LABEL[summary.status] : 'Checking…'}
        </span>
      </div>

      {!summary ? (
        <p className="readiness-line text-muted">
          Collecting flags, audio coverage and assignment checks…
        </p>
      ) : summary.status === 'ready' ? (
        // Five zeros is not an answer. Say what was actually verified.
        <p className="readiness-line readiness-line-ready">
          Nothing to fix across {summary.totalNodes}{' '}
          {summary.totalNodes === 1 ? vocab.node.singular : vocab.node.plural}: no parser errors,
          nothing unreachable, every {vocab.node.singular} voiced, no open flags, and every clip
          agrees with its filename.
        </p>
      ) : (
        <>
          {summary.blocking.length > 0 && (
            <div className="readiness-group readiness-group-blocking">
              <h3 className="readiness-group-title">Fix before you ship</h3>
              <ul className="readiness-list">
                {summary.blocking.map((c) => (
                  <CheckRow key={c.id} check={c} onNavigate={onNavigate} />
                ))}
              </ul>
            </div>
          )}
          {summary.review.length > 0 && (
            <div className="readiness-group readiness-group-review">
              <h3 className="readiness-group-title">Worth a look</h3>
              <ul className="readiness-list">
                {summary.review.map((c) => (
                  <CheckRow key={c.id} check={c} onNavigate={onNavigate} />
                ))}
              </ul>
            </div>
          )}
          {summary.unknown.length > 0 && (
            <div className="readiness-group readiness-group-unknown">
              <h3 className="readiness-group-title">Couldn&rsquo;t check</h3>
              <ul className="readiness-list">
                {summary.unknown.map((c) => (
                  <CheckRow key={c.id} check={c} detail={UNKNOWN_DETAIL} onNavigate={onNavigate} />
                ))}
              </ul>
            </div>
          )}
          {summary.blocking.length === 0 && summary.review.length === 0 && (
            <p className="readiness-line text-muted">Everything we could check came back clean.</p>
          )}
        </>
      )}
    </section>
  );
}
