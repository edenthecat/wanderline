import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AudioTab from '../AudioTab';
import type { StoryGraph } from '../../api/client';

// Regression (found in review): "Swap everywhere" built one
// bulk-reassign op per USAGE ROW, not per (nodeId, audioType) slot.
// A file used twice on the same slot under two different conditions
// produced two IDENTICAL ops; the backend's bulk-reassign already
// swaps every condition variant of a slot in a single op, so the
// first op removed both rows and the second (duplicate) op's DELETE
// matched nothing, rolling back the whole batch.

vi.mock('../../hooks/useYjs', () => ({ useYjs: () => ({ doc: null }) }));

const mockFetchAudioFiles = vi.hoisted(() => vi.fn());
const mockFetchAudioAssignments = vi.hoisted(() => vi.fn());
const mockFetchAudioCoverage = vi.hoisted(() => vi.fn());
const mockBulkReassignAudio = vi.hoisted(() => vi.fn());

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return {
    ...actual,
    fetchAudioFiles: mockFetchAudioFiles,
    fetchAudioAssignments: mockFetchAudioAssignments,
    fetchAudioCoverage: mockFetchAudioCoverage,
    bulkReassignAudio: mockBulkReassignAudio,
  };
});

function graph(): StoryGraph {
  return {
    id: 'g1',
    title: 'T',
    nodes: {
      start: { id: 'start', type: 'knot', content: [], choices: [], divert: null, tags: [] },
    },
    startNode: 'start',
    validation: { valid: true, errors: [], warnings: [] },
  } as unknown as StoryGraph;
}

beforeEach(() => {
  mockFetchAudioFiles.mockReset();
  mockFetchAudioAssignments.mockReset();
  mockFetchAudioCoverage.mockReset();
  mockBulkReassignAudio.mockReset();
  mockFetchAudioCoverage.mockResolvedValue({
    nodesWithoutAudio: [],
    orphanedAudioFiles: [],
    coverage: { total: 0, withAudio: 0, percentage: 0 },
  });
});

describe('AudioTab — swap everywhere', () => {
  it('sends ONE op per (node, slot) even when the file is used under two different conditions on the same slot', async () => {
    mockFetchAudioFiles.mockResolvedValue({
      audioFiles: [
        {
          id: 'file-a',
          project_id: 'p1',
          filename: 'a.mp3',
          original_name: 'A.mp3',
          mime_type: 'audio/mpeg',
          size_bytes: 100,
          category: 'voiceover',
          character_id: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
        {
          id: 'file-b',
          project_id: 'p1',
          filename: 'b.mp3',
          original_name: 'B.mp3',
          mime_type: 'audio/mpeg',
          size_bytes: 100,
          category: 'voiceover',
          character_id: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
      ],
    });
    mockFetchAudioAssignments.mockResolvedValue({
      assignments: {
        start: {
          voiceover: [
            { fileId: 'file-a' },
            {
              fileId: 'file-a',
              condition: { variable: 'seenIntro', operator: '==', value: true },
            },
          ],
          sfx: [],
        },
      },
      raw: [],
    });
    mockBulkReassignAudio.mockResolvedValue({ success: true, swapped: 2 });

    render(<AudioTab projectId="p1" storyGraph={graph()} />);

    const usageButton = await screen.findByText(/Used in 2/);
    fireEvent.click(usageButton);

    const panel = await screen.findByTestId('audio-usage-panel');
    // The panel also renders a per-row "Replace with…" select for
    // each usage row — the swap-everywhere target select is the
    // first combobox, rendered before that table.
    const select = within(panel).getAllByRole('combobox')[0];
    fireEvent.change(select, { target: { value: 'file-b' } });

    fireEvent.click(within(panel).getByTestId('audio-swap-everywhere'));

    await waitFor(() => {
      expect(mockBulkReassignAudio).toHaveBeenCalledTimes(1);
    });
    expect(mockBulkReassignAudio).toHaveBeenCalledWith('p1', [
      { nodeId: 'start', audioType: 'voiceover', fromFileId: 'file-a', toFileId: 'file-b' },
    ]);
  });
});
