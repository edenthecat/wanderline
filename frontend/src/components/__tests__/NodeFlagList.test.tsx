import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NodeDetail from '../NodeDetail';
import * as client from '../../api/client';

// Raising a flag and acting on it happen in different places — the
// reviewer is listening, the author is editing — so the report has to
// land on the passage in the editor, with a way to clear it.

vi.mock('../CollabChoiceTextInput', () => ({ default: () => null }));
vi.mock('../CollabContentTextarea', () => ({ default: () => null }));

const flag = (over: Partial<client.NodeFlag> = {}): client.NodeFlag => ({
  id: 'fl1',
  nodeId: 'her',
  reason: 'incorrect_audio',
  note: 'wrong take',
  createdAt: '2026-08-27T10:00:00Z',
  resolvedAt: null,
  createdByName: 'Eden',
  ...over,
});

function props(over: Record<string, unknown> = {}) {
  return {
    nodeId: 'her',
    node: { content: [{ text: 'Hi.', tags: [] }], choices: [], divert: null, tags: [] },
    metadataLoaded: true,
    nodeIdSet: new Set(['her']),
    nodeIdOptions: null,
    projectId: 'p1',
    onChoiceTextEdit: vi.fn(),
    onContentEdit: vi.fn(),
    onChoiceTargetEdit: vi.fn(),
    onDivertEdit: vi.fn(),
    onAddChoice: vi.fn(),
    onDeleteChoice: vi.fn(),
    onSwapChoices: vi.fn(),
    onRenameNode: vi.fn(),
    onMetadataSave: vi.fn(),
    yDoc: null,
    yDocReady: false,
    ...over,
  } as unknown as React.ComponentProps<typeof NodeDetail>;
}

afterEach(() => vi.restoreAllMocks());

describe('NodeDetail — flags', () => {
  it('shows the reason and the reviewer’s note', () => {
    render(<NodeDetail {...props({ flags: [flag()] })} />);
    expect(screen.getByText('Incorrect audio')).toBeTruthy();
    expect(screen.getByText('wrong take')).toBeTruthy();
  });

  it('renders nothing when the passage is unflagged', () => {
    const { container } = render(<NodeDetail {...props({ flags: [] })} />);
    expect(container.querySelector('.node-flags')).toBeNull();
  });

  it('counts multiple flags on the same passage', () => {
    render(
      <NodeDetail
        {...props({ flags: [flag(), flag({ id: 'fl2', reason: 'needs_text_edit', note: null })] })}
      />,
    );
    expect(screen.getByText('Needs a text edit')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('resolves a flag and tells the parent to refresh', async () => {
    const resolve = vi.spyOn(client, 'resolveNodeFlag').mockResolvedValue({ resolved: true });
    const onFlagsChanged = vi.fn();
    render(<NodeDetail {...props({ flags: [flag()], onFlagsChanged })} />);
    fireEvent.click(screen.getByLabelText(/Mark "Incorrect audio" resolved/));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('p1', 'fl1'));
    await waitFor(() => expect(onFlagsChanged).toHaveBeenCalled());
  });

  it('keeps the flag visible when resolving fails', async () => {
    vi.spyOn(client, 'resolveNodeFlag').mockRejectedValue(new Error('nope'));
    render(<NodeDetail {...props({ flags: [flag()] })} />);
    fireEvent.click(screen.getByLabelText(/Mark "Incorrect audio" resolved/));
    expect(await screen.findByText('nope')).toBeTruthy();
    expect(screen.getByText('Incorrect audio')).toBeTruthy();
  });
});
