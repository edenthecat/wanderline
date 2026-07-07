// Author QoL: collapsible "Story health" strip at the top of
// StoryTab. Surfaces three signals the parser already knows about
// but didn't have a UI home for:
//   - Unreachable nodes (orphaned content)
//   - Dead-ends (reachable nodes the listener can't progress past
//     and that aren't tagged as endings)
//   - Word count + playtime estimate (so the author knows how long
//     their thing is)
//
// Clicking a node id calls `onJumpToNode` — the parent handles
// scrolling + expanding that node, same as the existing
// ValidationPanel's "Jump to node" affordance.

import { useMemo, useState } from 'react';
import type { StoryGraph } from '../api/client';
import { computeStoryHealth } from '../lib/storyHealth';

interface Props {
  storyGraph: StoryGraph | null;
  onJumpToNode: (nodeId: string) => void;
}

export default function StoryHealthPanel({ storyGraph, onJumpToNode }: Props) {
  const [expanded, setExpanded] = useState(false);
  // Parent re-renders on every search keystroke / metadata save /
  // awareness change. Memoize on the graph reference so we don't
  // walk a 500-knot BFS per keystroke.
  const report = useMemo(() => computeStoryHealth(storyGraph), [storyGraph]);
  if (report.totalNodes === 0) return null;

  const hasIssues = report.unreachableNodes.length > 0 || report.deadEndNodes.length > 0;

  const bodyId = 'story-health-body';
  return (
    <section className="story-health" data-testid="story-health" aria-label="Story health">
      <button
        type="button"
        className="story-health-summary"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
      >
        <span className="story-health-toggle" aria-hidden="true">
          {expanded ? '▼' : '▶'}
        </span>
        <span className="story-health-stat">
          <strong>{report.totalNodes}</strong> nodes
        </span>
        <span className="story-health-stat">
          <strong>{report.totalWords.toLocaleString()}</strong> words
        </span>
        <span className="story-health-stat">
          ~<strong>{report.estimatedMinutes}</strong> min
        </span>
        {hasIssues ? (
          <span className="story-health-badge story-health-badge-warn">
            {report.unreachableNodes.length + report.deadEndNodes.length} issue
            {report.unreachableNodes.length + report.deadEndNodes.length === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="story-health-badge story-health-badge-ok">no issues</span>
        )}
      </button>

      {expanded && (
        <div id={bodyId} className="story-health-body">
          {report.unreachableNodes.length > 0 && (
            <div className="story-health-section" data-testid="health-unreachable">
              <h4>Unreachable nodes</h4>
              <p className="text-sm text-muted">
                These nodes exist in the file but nothing in the story diverts or chooses into them.
                Listeners will never see them.
              </p>
              <ul className="story-health-list">
                {report.unreachableNodes.map((id) => (
                  <li key={id}>
                    <button
                      type="button"
                      className="story-health-link"
                      onClick={() => onJumpToNode(id)}
                    >
                      {id}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.deadEndNodes.length > 0 && (
            <div className="story-health-section" data-testid="health-deadends">
              <h4>Dead-ends</h4>
              <p className="text-sm text-muted">
                These nodes are reachable but have no outgoing path AND no <code>#ending</code> tag.
                The listener will hit silence here. Add a choice, a divert, or tag the node as an
                ending.
              </p>
              <ul className="story-health-list">
                {report.deadEndNodes.map((id) => (
                  <li key={id}>
                    <button
                      type="button"
                      className="story-health-link"
                      onClick={() => onJumpToNode(id)}
                    >
                      {id}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!hasIssues && (
            <p className="text-sm text-muted">
              Every node is reachable and resolves to an ending or another node. Word count estimate
              uses ~160 wpm narrator pace.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
