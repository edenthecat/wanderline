import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ShipReadinessPanel from '../ShipReadinessPanel';
import * as client from '../../api/client';
import { PANEL_ANCHORS } from '../../lib/panelAnchors';

function graph(over: Partial<client.StoryGraph> = {}): client.StoryGraph {
  return {
    id: 'g1',
    title: 'Story',
    startNode: 'start',
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        parent: null,
        content: [],
        choices: [],
        divert: 'END',
        tags: [],
        lineNumber: 1,
      },
    },
    validation: { valid: true, errors: [], warnings: [] },
    ...over,
  };
}

function stubLookups({
  flags = 0,
  missingVoiceover = 0,
  disagreements = 0,
}: { flags?: number; missingVoiceover?: number; disagreements?: number } = {}) {
  vi.spyOn(client, 'fetchNodeFlags').mockResolvedValue({
    total: flags,
    truncated: false,
    flags: [],
  });
  vi.spyOn(client, 'fetchAudioCoverage').mockResolvedValue({
    nodesWithoutAudio: Array.from({ length: missingVoiceover }, (_, i) => `n${i}`),
    orphanedAudioFiles: [],
    coverage: { total: 1, withAudio: 1, percentage: 100 },
  });
  vi.spyOn(client, 'auditAudioAssignments').mockResolvedValue({
    totalAssignments: 3,
    acknowledged: 0,
    disagreements: Array.from({ length: disagreements }, () => ({
      audioFileId: 'f1',
      filename: 'intro.mp3',
      currentNodeId: 'start',
      currentAudioType: 'voiceover',
      suggestedNodeId: 'other',
      suggestedAudioType: 'voiceover',
      reason: 'different-node' as const,
      currentNodeExists: true,
    })),
  });
}

// The Ship tab must call a node whatever the panel it links to calls
// it, so the vocab is a required input rather than a default.
const vocabProps = { sourceLanguage: 'ink' as const, nomenclaturePreference: 'auto' as const };

afterEach(() => vi.restoreAllMocks());

describe('ShipReadinessPanel', () => {
  // Five zeros is not an answer to "can I ship this?".
  it('says what it verified when everything is clean', async () => {
    stubLookups();
    render(
      <ShipReadinessPanel
        projectId="p1"
        storyGraph={graph()}
        onNavigate={() => {}}
        {...vocabProps}
      />,
    );
    expect(await screen.findByText('Ready to ship')).toBeInTheDocument();
    expect(screen.getByText(/Nothing to fix across 1 knot/)).toBeInTheDocument();
    expect(screen.queryByText('Worth a look')).not.toBeInTheDocument();
  });

  it('separates what blocks a ship from what merely wants a look', async () => {
    stubLookups({ flags: 3 });
    render(
      <ShipReadinessPanel
        projectId="p1"
        storyGraph={graph({
          validation: {
            valid: false,
            errors: [{ type: 'syntax_error', message: 'unclosed [' }],
            warnings: [],
          },
        })}
        onNavigate={() => {}}
        {...vocabProps}
      />,
    );
    expect(await screen.findByText('Fix before you ship')).toBeInTheDocument();
    expect(screen.getByText('1 parser error')).toBeInTheDocument();
    expect(screen.getByText('Worth a look')).toBeInTheDocument();
    expect(screen.getByText('3 unresolved flags')).toBeInTheDocument();
    expect(screen.getByText('Not ready')).toBeInTheDocument();
  });

  it('hands the owning panel back to the page when a row is clicked', async () => {
    stubLookups({ missingVoiceover: 4 });
    const onNavigate = vi.fn();
    render(
      <ShipReadinessPanel
        projectId="p1"
        storyGraph={graph()}
        onNavigate={onNavigate}
        {...vocabProps}
      />,
    );
    await userEvent.click(await screen.findByText('4 knots with no voiceover'));
    expect(onNavigate).toHaveBeenCalledWith({
      tab: 'audio',
      anchorId: PANEL_ANCHORS.missingVoiceover,
    });
  });

  // A dead lookup must degrade one check, not blank the summary and
  // not quietly read as zero.
  it('reports a failed lookup as unchecked instead of clean', async () => {
    stubLookups();
    vi.spyOn(client, 'fetchNodeFlags').mockRejectedValue(new Error('500'));
    render(
      <ShipReadinessPanel
        projectId="p1"
        storyGraph={graph()}
        onNavigate={() => {}}
        {...vocabProps}
      />,
    );
    expect(await screen.findByText('Couldn’t check')).toBeInTheDocument();
    expect(screen.getByText('Unresolved flags')).toBeInTheDocument();
    expect(screen.queryByText('Ready to ship')).not.toBeInTheDocument();
    expect(screen.getByText('Partly checked')).toBeInTheDocument();
  });

  // An unanswered check must not borrow the copy that asserts the
  // problem is real — that is the claim the null exists to avoid.
  it('does not assert a problem it could not check for', async () => {
    stubLookups();
    vi.spyOn(client, 'fetchNodeFlags').mockRejectedValue(new Error('500'));
    render(
      <ShipReadinessPanel
        projectId="p1"
        storyGraph={graph()}
        onNavigate={() => {}}
        {...vocabProps}
      />,
    );
    expect(await screen.findByText('Unresolved flags')).toBeInTheDocument();
    expect(screen.queryByText(/Someone reported a problem/)).not.toBeInTheDocument();
    expect(screen.getByText(/didn’t answer/)).toBeInTheDocument();
  });

  // allSettled covers a rejected request, not a 200 whose body is not
  // what we expect — a proxy's own error page, or a backend a version
  // ahead. Reading through that used to throw past setCounts and leave
  // the panel on "Checking…" forever.
  it('degrades to unknown when a request succeeds with the wrong shape', async () => {
    stubLookups();
    vi.spyOn(client, 'fetchAudioCoverage').mockResolvedValue({
      error: 'Bad Gateway',
    } as unknown as client.AudioCoverage);
    render(
      <ShipReadinessPanel
        projectId="p1"
        storyGraph={graph()}
        onNavigate={() => {}}
        {...vocabProps}
      />,
    );
    expect(await screen.findByText('Couldn’t check')).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
  });

  it('renders nothing, and asks nothing, until there is a story', () => {
    stubLookups();
    const { container } = render(
      <ShipReadinessPanel projectId="p1" storyGraph={null} onNavigate={() => {}} {...vocabProps} />,
    );
    expect(container).toBeEmptyDOMElement();
    // The audit re-matches every assignment server-side; paying for
    // that to throw the answer away is the point of the guard.
    expect(client.auditAudioAssignments).not.toHaveBeenCalled();
    expect(client.fetchNodeFlags).not.toHaveBeenCalled();
    expect(client.fetchAudioCoverage).not.toHaveBeenCalled();
  });

  it('follows the project’s own terminology', async () => {
    stubLookups({ missingVoiceover: 2 });
    render(
      <ShipReadinessPanel
        projectId="p1"
        storyGraph={graph()}
        onNavigate={() => {}}
        sourceLanguage="twee"
        nomenclaturePreference="auto"
      />,
    );
    expect(await screen.findByText('2 passages with no voiceover')).toBeInTheDocument();
  });

  it('reads the true open-flag count, not the page the flags panel lists', async () => {
    stubLookups();
    vi.spyOn(client, 'fetchNodeFlags').mockResolvedValue({
      // The server caps the returned page; `total` is the real count.
      total: 42,
      truncated: true,
      flags: [],
    });
    render(
      <ShipReadinessPanel
        projectId="p1"
        storyGraph={graph()}
        onNavigate={() => {}}
        {...vocabProps}
      />,
    );
    expect(await screen.findByText('42 unresolved flags')).toBeInTheDocument();
  });
});
