import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AssignmentAuditPanel from '../AssignmentAuditPanel';
import * as client from '../../api/client';

// The audit exists because /rematch skips already-assigned files, so a
// project populated under older matching logic never gets re-examined.
// "Mark as fine" exists because plenty of disagreements are deliberate,
// and a report that keeps raising known-good rows stops being read.

const row = (over: Partial<client.AssignmentDisagreement> = {}): client.AssignmentDisagreement => ({
  audioFileId: 'f1',
  filename: 'intro.mp3',
  currentNodeId: 'chapter1.intro',
  currentAudioType: 'voiceover',
  suggestedNodeId: 'intro',
  suggestedAudioType: 'voiceover',
  reason: 'different-node',
  currentNodeExists: true,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('AssignmentAuditPanel', () => {
  it('reports a clean project without alarming anyone', async () => {
    vi.spyOn(client, 'auditAudioAssignments').mockResolvedValue({
      totalAssignments: 12,
      acknowledged: 0,
      disagreements: [],
    });
    render(<AssignmentAuditPanel projectId="p1" />);
    fireEvent.click(screen.getByText('Check assignments'));
    expect(await screen.findByText(/nothing left to review/)).toBeTruthy();
  });

  it('lists where a clip is versus where its name points', async () => {
    vi.spyOn(client, 'auditAudioAssignments').mockResolvedValue({
      totalAssignments: 12,
      acknowledged: 0,
      disagreements: [row()],
    });
    render(<AssignmentAuditPanel projectId="p1" />);
    fireEvent.click(screen.getByText('Check assignments'));
    expect(await screen.findByText('intro.mp3')).toBeTruthy();
    expect(screen.getByText('chapter1.intro')).toBeTruthy();
    expect(screen.getByText('intro')).toBeTruthy();
  });

  // An assignment to a passage the story no longer has can't be right,
  // so it's called out rather than left to look like the others.
  it('flags an assignment whose node no longer exists', async () => {
    vi.spyOn(client, 'auditAudioAssignments').mockResolvedValue({
      totalAssignments: 3,
      acknowledged: 0,
      disagreements: [row({ currentNodeExists: false })],
    });
    render(<AssignmentAuditPanel projectId="p1" />);
    fireEvent.click(screen.getByText('Check assignments'));
    expect(await screen.findByText(/node missing/)).toBeTruthy();
  });

  it('marks a row as fine and removes it from the list', async () => {
    vi.spyOn(client, 'auditAudioAssignments').mockResolvedValue({
      totalAssignments: 12,
      acknowledged: 0,
      disagreements: [row()],
    });
    const ack = vi.spyOn(client, 'acknowledgeAssignment').mockResolvedValue({ acknowledged: true });
    render(<AssignmentAuditPanel projectId="p1" />);
    fireEvent.click(screen.getByText('Check assignments'));
    fireEvent.click(await screen.findByText('Mark as fine'));

    // Keyed on the exact assignment, not just the file — moving the
    // clip should re-raise it rather than inherit the approval.
    await waitFor(() =>
      expect(ack).toHaveBeenCalledWith('p1', {
        audioFileId: 'f1',
        nodeId: 'chapter1.intro',
        audioType: 'voiceover',
      }),
    );
    await waitFor(() => expect(screen.queryByText('intro.mp3')).toBeNull());
  });

  // Counted, not hidden: "nothing is wrong" has to stay distinguishable
  // from "everything was waved through months ago".
  it('says how many were previously marked fine', async () => {
    vi.spyOn(client, 'auditAudioAssignments').mockResolvedValue({
      totalAssignments: 12,
      acknowledged: 4,
      disagreements: [],
    });
    render(<AssignmentAuditPanel projectId="p1" />);
    fireEvent.click(screen.getByText('Check assignments'));
    expect(await screen.findByText(/4 marked as fine/)).toBeTruthy();
  });

  it('keeps the row when marking it fine fails', async () => {
    vi.spyOn(client, 'auditAudioAssignments').mockResolvedValue({
      totalAssignments: 1,
      acknowledged: 0,
      disagreements: [row()],
    });
    vi.spyOn(client, 'acknowledgeAssignment').mockRejectedValue(new Error('nope'));
    render(<AssignmentAuditPanel projectId="p1" />);
    fireEvent.click(screen.getByText('Check assignments'));
    fireEvent.click(await screen.findByText('Mark as fine'));
    expect(await screen.findByText('nope')).toBeTruthy();
    expect(screen.getByText('intro.mp3')).toBeTruthy();
  });
});
