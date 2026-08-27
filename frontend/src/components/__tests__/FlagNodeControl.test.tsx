import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FlagNodeControl from '../FlagNodeControl';
import * as client from '../../api/client';

// A reviewer notices problems while listening, and means the passage
// playing right now. The control names that passage and files against
// it directly, rather than asking them to remember an id.

afterEach(() => vi.restoreAllMocks());

describe('FlagNodeControl', () => {
  // Flagging "nothing" would file a report nobody can act on.
  it('is disabled until the player reports a passage', () => {
    render(<FlagNodeControl projectId="p1" nodeId={null} />);
    expect((screen.getByText('Flag this passage') as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the passage being flagged', () => {
    render(<FlagNodeControl projectId="p1" nodeId="chapter1.intro" />);
    fireEvent.click(screen.getByText('Flag this passage'));
    expect(screen.getByText('chapter1.intro')).toBeTruthy();
  });

  it('offers the three reasons', () => {
    render(<FlagNodeControl projectId="p1" nodeId="her" />);
    fireEvent.click(screen.getByText('Flag this passage'));
    expect(screen.getByLabelText(/Flag this passage/i)).toBeTruthy();
    expect(screen.getByText("Doesn't work correctly")).toBeTruthy();
    expect(screen.getByText('Incorrect audio')).toBeTruthy();
    expect(screen.getByText('Needs a text edit')).toBeTruthy();
  });

  it('files the chosen reason against the current passage', async () => {
    const create = vi.spyOn(client, 'createNodeFlag').mockResolvedValue({
      flag: {} as client.NodeFlag,
    });
    const onFlagged = vi.fn();
    render(<FlagNodeControl projectId="p1" nodeId="her" onFlagged={onFlagged} />);
    fireEvent.click(screen.getByText('Flag this passage'));
    fireEvent.click(screen.getByText('Incorrect audio'));
    fireEvent.change(screen.getByLabelText('Flag note'), {
      target: { value: 'wrong take' },
    });
    fireEvent.click(screen.getByText('Flag it'));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('p1', {
        nodeId: 'her',
        reason: 'incorrect_audio',
        note: 'wrong take',
      }),
    );
    await waitFor(() => expect(onFlagged).toHaveBeenCalled());
  });

  // The note is context, not a requirement — a reviewer mid-listen
  // shouldn't have to compose prose to report a problem.
  it('omits an empty note rather than sending blank text', async () => {
    const create = vi.spyOn(client, 'createNodeFlag').mockResolvedValue({
      flag: {} as client.NodeFlag,
    });
    render(<FlagNodeControl projectId="p1" nodeId="her" />);
    fireEvent.click(screen.getByText('Flag this passage'));
    fireEvent.click(screen.getByText('Flag it'));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('p1', { nodeId: 'her', reason: 'not_working' }),
    );
  });

  it('confirms which passage was flagged', async () => {
    vi.spyOn(client, 'createNodeFlag').mockResolvedValue({ flag: {} as client.NodeFlag });
    render(<FlagNodeControl projectId="p1" nodeId="her" />);
    fireEvent.click(screen.getByText('Flag this passage'));
    fireEvent.click(screen.getByText('Flag it'));
    expect(await screen.findByText(/Flagged/)).toBeTruthy();
  });

  it('keeps the form open when filing fails', async () => {
    vi.spyOn(client, 'createNodeFlag').mockRejectedValue(new Error('server said no'));
    render(<FlagNodeControl projectId="p1" nodeId="her" />);
    fireEvent.click(screen.getByText('Flag this passage'));
    fireEvent.click(screen.getByText('Flag it'));
    expect(await screen.findByText('server said no')).toBeTruthy();
    expect(screen.getByText('Flag it')).toBeTruthy();
  });
});
