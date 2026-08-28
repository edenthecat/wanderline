import { render, screen, fireEvent } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import NodeDetail from '../NodeDetail';
import { PreviewFromNodeContext, StoryCardNode } from '../GraphTab';

// "Preview from here" on the two editing surfaces that show a single
// passage. The third — the flagged-items list — is covered in
// FlaggedNodesPanel.test.tsx alongside the rest of that panel.

vi.mock('../CollabChoiceTextInput', () => ({ default: () => null }));
vi.mock('../CollabContentTextarea', () => ({ default: () => null }));

const nodeDetailProps = {
  nodeId: 'tell_you.middle',
  node: { content: [{ text: 'Forty minutes in.', tags: [] }], choices: [], divert: null, tags: [] },
  metadataLoaded: true,
  nodeIdSet: new Set(['tell_you.middle']),
  nodeIdOptions: null,
  projectId: 'p1',
  onChoiceTextEdit: vi.fn(),
  onContentEdit: vi.fn(),
  onChoiceTargetEdit: vi.fn(),
  onDivertEdit: vi.fn(),
  onMetadataSave: vi.fn(),
  yDoc: null,
  yDocReady: false,
} as unknown as React.ComponentProps<typeof NodeDetail>;

function cardData(id: string) {
  return {
    storyNode: { id, type: 'stitch', content: [], choices: [], divert: null, tags: [] },
    isStart: false,
    isEnding: false,
    severity: null,
    hasAudio: true,
    character: null,
    flagCount: 0,
    choices: [],
    hasDivert: false,
    preview: '',
    cardHeight: 78,
    dim: false,
    onPath: false,
    matched: false,
    unmatched: false,
  };
}

function renderCard(onPreviewFromNode: ((nodeId: string) => void) | null) {
  const props = {
    id: 'tell_you.middle',
    data: cardData('tell_you.middle'),
    selected: false,
  } as unknown as NodeProps;
  return render(
    <ReactFlowProvider>
      <PreviewFromNodeContext.Provider value={onPreviewFromNode}>
        <StoryCardNode {...props} />
      </PreviewFromNodeContext.Provider>
    </ReactFlowProvider>,
  );
}

describe('NodeDetail — preview from here', () => {
  it('starts the preview at this passage', () => {
    const onPreviewFromNode = vi.fn();
    render(<NodeDetail {...nodeDetailProps} onPreviewFromNode={onPreviewFromNode} />);
    fireEvent.click(screen.getByLabelText('Preview from tell_you.middle'));
    expect(onPreviewFromNode).toHaveBeenCalledWith('tell_you.middle');
  });

  // Hosts without a preview surface to switch to shouldn't render a
  // control that can't do anything.
  it('offers nothing when the host has no preview surface', () => {
    render(<NodeDetail {...nodeDetailProps} />);
    expect(screen.queryByLabelText('Preview from tell_you.middle')).toBeNull();
  });
});

describe('graph card — preview from here', () => {
  it('starts the preview at the card’s passage', () => {
    const onPreviewFromNode = vi.fn();
    renderCard(onPreviewFromNode);
    fireEvent.click(screen.getByLabelText('Preview from tell_you.middle'));
    expect(onPreviewFromNode).toHaveBeenCalledWith('tell_you.middle');
  });

  // React Flow treats a mousedown on a node as the start of a drag.
  // Without `nodrag` the press is swallowed and the button never fires.
  it('keeps React Flow’s drag handler off the button', () => {
    renderCard(vi.fn());
    expect(screen.getByLabelText('Preview from tell_you.middle').classList.contains('nodrag')).toBe(
      true,
    );
  });

  it('offers nothing when the host has no preview surface', () => {
    renderCard(null);
    expect(screen.queryByLabelText('Preview from tell_you.middle')).toBeNull();
  });
});
