import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NodeDeleteButton from '../NodeDeleteButton';

// Deleting a passage other passages link to is the case that matters:
// the author has to say where those links go, and the answer travels
// with the delete so the two land in one transaction.

function open(label = 'Delete kitchen') {
  fireEvent.click(screen.getByLabelText(label));
}

describe('NodeDeleteButton', () => {
  it('deletes without asking for a replacement when nothing points here', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <NodeDeleteButton
        nodeId="kitchen"
        doomedIds={['kitchen']}
        referrers={[]}
        allNodeIds={['hall', 'kitchen']}
        onDelete={onDelete}
      />,
    );
    open();
    expect(screen.queryByLabelText('Replacement target')).toBeNull();
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('kitchen', undefined));
  });

  it('asks where inbound links should go and sends the answer', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <NodeDeleteButton
        nodeId="kitchen"
        doomedIds={['kitchen']}
        referrers={['hall', 'porch']}
        allNodeIds={['hall', 'kitchen', 'porch']}
        onDelete={onDelete}
      />,
    );
    open();
    expect(screen.getByText(/2 passages point here/)).toBeTruthy();
    const select = screen.getByLabelText('Replacement target') as HTMLSelectElement;
    // The passage being deleted is never offered as its own
    // replacement — the server rejects that.
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'END',
      'DONE',
      'hall',
      'porch',
    ]);
    fireEvent.change(select, { target: { value: 'porch' } });
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('kitchen', 'porch'));
  });

  it('names the sub-nodes that go with a knot', () => {
    render(
      <NodeDeleteButton
        nodeId="ch1"
        doomedIds={['ch1', 'ch1.a', 'ch1.b']}
        referrers={[]}
        allNodeIds={['ch1', 'ch1.a', 'ch1.b']}
        onDelete={vi.fn()}
      />,
    );
    open('Delete ch1');
    expect(screen.getByText(/and its 2 sub-nodes/)).toBeTruthy();
  });

  it('reveals the replacement control when the server finds referrers the graph did not', async () => {
    // A legacy Ink graph can hold a bare `-> scene` that the local
    // reverse-edge index (exact match only) misses. The server catches
    // it, and the retry has to be able to answer.
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Can’t delete "kitchen" — 1 other passage still points at it: hall.'),
      )
      .mockResolvedValueOnce(undefined);
    render(
      <NodeDeleteButton
        nodeId="kitchen"
        doomedIds={['kitchen']}
        referrers={[]}
        allNodeIds={['hall', 'kitchen']}
        onDelete={onDelete}
      />,
    );
    open();
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const select = (await screen.findByLabelText('Replacement target')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'hall' } });
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(onDelete).toHaveBeenLastCalledWith('kitchen', 'hall'));
  });

  it('refuses up front for the start passage instead of offering a dead end', () => {
    render(
      <NodeDeleteButton
        nodeId="intro"
        doomedIds={['intro']}
        referrers={[]}
        allNodeIds={['intro']}
        onDelete={vi.fn()}
        blockedReason="intro is the start"
      />,
    );
    const button = screen.getByLabelText('Delete intro (unavailable)') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
