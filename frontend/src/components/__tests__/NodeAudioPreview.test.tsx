import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NodeDetail from '../NodeDetail';

// Authors assign audio in the Audio tab, then had no way to confirm
// they'd attached the right take without building the whole story.
// These pin the audition rows the node panel now offers.

vi.mock('../CollabChoiceTextInput', () => ({ default: () => null }));
vi.mock('../CollabContentTextarea', () => ({ default: () => null }));

const baseProps = {
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
} as unknown as React.ComponentProps<typeof NodeDetail>;

describe('NodeDetail — attached audio', () => {
  it('offers a play control for each attached clip', () => {
    render(
      <NodeDetail
        {...baseProps}
        nodeAudio={{ voiceover: 'f1', choice1: 'f2', sfx: [] }}
        audioNames={{ f1: 'her-vo.mp3', f2: 'cue-a.mp3' }}
      />,
    );
    expect(screen.getByLabelText('Play Voiceover')).toBeTruthy();
    expect(screen.getByLabelText('Play Choice 1 cue')).toBeTruthy();
    expect(screen.getByText('her-vo.mp3')).toBeTruthy();
  });

  it('lists sfx clips too', () => {
    render(
      <NodeDetail
        {...baseProps}
        nodeAudio={{ sfx: ['s1', 's2'] }}
        audioNames={{ s1: 'door.mp3' }}
      />,
    );
    expect(screen.getByLabelText('Play SFX 1')).toBeTruthy();
    expect(screen.getByLabelText('Play SFX 2')).toBeTruthy();
  });

  // The panel is an affordance on top of the editor; a node with no
  // audio, or a failed lookup, must not leave an empty heading behind.
  it.each([
    ['no clips attached', { sfx: [] }],
    ['lookup unavailable', undefined],
  ])('renders nothing when %s', (_label, nodeAudio) => {
    const { container } = render(<NodeDetail {...baseProps} nodeAudio={nodeAudio} />);
    expect(container.querySelector('.node-audio-preview')).toBeNull();
  });

  // Falls back to the id so a row still plays when the name lookup is
  // missing an entry, rather than rendering a blank label.
  it('falls back to the file id when the name is unknown', () => {
    render(<NodeDetail {...baseProps} nodeAudio={{ voiceover: 'f9', sfx: [] }} audioNames={{}} />);
    expect(screen.getByText('f9')).toBeTruthy();
  });
});
