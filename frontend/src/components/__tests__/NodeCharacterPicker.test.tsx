import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NodeDetail from '../NodeDetail';

// The character_id column, the API and the player's per-character
// theming have existed since the baseline migration; the editor control
// to set it never made it into this repo, so the field was unreachable
// outside a direct database edit.

vi.mock('../CollabChoiceTextInput', () => ({ default: () => null }));
vi.mock('../CollabContentTextarea', () => ({ default: () => null }));

const CHARACTERS = [
  { id: 'c1', name: 'Sam', color: '#3b82f6', theme: 'blue' },
  { id: 'c2', name: 'Anna', color: '#ec4899', theme: 'pink' },
] as unknown as React.ComponentProps<typeof NodeDetail>['characters'];

function props(over: Record<string, unknown> = {}) {
  return {
    nodeId: 'her',
    node: { content: [{ text: 'Hi.', tags: [] }], choices: [], divert: null, tags: [] },
    metadataLoaded: true,
    nodeIdSet: new Set(['her']),
    nodeIdOptions: null,
    projectId: 'p1',
    characters: CHARACTERS,
    onChoiceTextEdit: vi.fn(),
    onContentEdit: vi.fn(),
    onChoiceTargetEdit: vi.fn(),
    onDivertEdit: vi.fn(),
    onAddChoice: vi.fn(),
    onDeleteChoice: vi.fn(),
    onSwapChoices: vi.fn(),
    onRenameNode: vi.fn(),
    onMetadataSave: vi.fn().mockResolvedValue(undefined),
    yDoc: null,
    yDocReady: false,
    ...over,
  } as unknown as React.ComponentProps<typeof NodeDetail>;
}

describe('NodeDetail — character picker', () => {
  it('lists the project characters', () => {
    render(<NodeDetail {...props()} />);
    const select = screen.getByLabelText('Character speaking this passage');
    expect(select).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Sam' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Anna' })).toBeTruthy();
  });

  it('reflects the character already stored on the node', () => {
    render(<NodeDetail {...props({ metadata: { characterId: 'c2' } })} />);
    expect(
      (screen.getByLabelText('Character speaking this passage') as HTMLSelectElement).value,
    ).toBe('c2');
  });

  it('saves the chosen character', async () => {
    const onMetadataSave = vi.fn().mockResolvedValue(undefined);
    render(<NodeDetail {...props({ onMetadataSave })} />);
    fireEvent.change(screen.getByLabelText('Character speaking this passage'), {
      target: { value: 'c1' },
    });
    await waitFor(() => expect(onMetadataSave).toHaveBeenCalledWith({ characterId: 'c1' }));
  });

  // Omitting the key tells the API to leave the value alone, so a clear
  // has to be an explicit null or it silently does nothing.
  it('clears with an explicit null rather than undefined', async () => {
    const onMetadataSave = vi.fn().mockResolvedValue(undefined);
    render(<NodeDetail {...props({ metadata: { characterId: 'c1' }, onMetadataSave })} />);
    fireEvent.change(screen.getByLabelText('Character speaking this passage'), {
      target: { value: '' },
    });
    await waitFor(() => expect(onMetadataSave).toHaveBeenCalledWith({ characterId: null }));
  });

  // Nothing to choose between; the Characters tab is where that starts.
  it('renders nothing when the project has no characters', () => {
    const { container } = render(<NodeDetail {...props({ characters: [] })} />);
    expect(container.querySelector('.node-character')).toBeNull();
  });

  it('is locked until metadata has loaded, so it cannot overwrite blind', () => {
    render(<NodeDetail {...props({ metadataLoaded: false })} />);
    expect(
      (screen.getByLabelText('Character speaking this passage') as HTMLSelectElement).disabled,
    ).toBe(true);
  });
});
