// The Graph-tab end of the ⌘K handoff. React Flow is stubbed — this
// suite is about the jump effect's decisions (centre, acknowledge,
// evict the source panel), not about a real canvas.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryGraph, StoryNode } from '../../api/client';

// One stable object: useNodeEditor's result feeds memo dependencies
// that drive the dagre layout, so returning fresh literals per render
// spins GraphTab in an infinite re-layout loop.
const h = vi.hoisted(() => ({
  setCenter: vi.fn(),
  editor: {
    metadata: {},
    metadataLoaded: true,
    audioByNode: {},
    audioNames: {},
    characters: [],
    flagsByNode: {},
    flagsTruncated: false,
    refreshFlags: () => {},
    metadataError: null,
    retryMetadata: () => {},
    nodeIdSet: new Set(['intro', 'harbour']),
    nodeIdOptions: ['intro', 'harbour'],
    reverseEdges: new Map(),
    handleChoiceTextEdit: () => {},
    handleNodeContentEdit: () => {},
    handleChoiceTargetEdit: () => {},
    handleDivertEdit: () => {},
    handleAddChoice: () => {},
    handleDeleteChoice: () => {},
    handleSwapChoices: () => {},
    handleRenameNode: () => {},
    handleMetadataSave: () => {},
    editorError: null,
    clearEditorError: () => {},
  },
}));

function node(id: string): StoryNode {
  return {
    id,
    type: 'knot',
    parent: null,
    content: [{ text: `Content of ${id}.`, tags: [] }],
    choices: [],
    divert: null,
    tags: [],
    lineNumber: 1,
  };
}

const storyGraph: StoryGraph = {
  id: 'g1',
  title: 'Test story',
  nodes: { intro: node('intro'), harbour: node('harbour') },
  startNode: 'intro',
  validation: { valid: true, errors: [], warnings: [] },
};

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => <div data-testid="react-flow" />,
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
  applyEdgeChanges: (_changes: unknown, edges: unknown) => edges,
  useReactFlow: () => ({ setCenter: h.setCenter }),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../api/client', () => ({
  updateChoiceTarget: vi.fn(),
  updateDivert: vi.fn(),
  uploadInk: vi.fn(),
}));

vi.mock('../../hooks/useYjs', () => ({ useYjs: () => ({ doc: null }) }));
vi.mock('../../hooks/useStoryYDoc', () => ({ useYjsSeedReady: () => true }));
vi.mock('../../hooks/useNodeEditor', () => ({ useNodeEditor: () => h.editor }));
vi.mock('../NodeDetail', () => ({ default: () => <div data-testid="node-detail" /> }));
vi.mock('../InkSourceEditor', () => ({
  default: ({ onDirtyChange }: { onDirtyChange?: (d: boolean) => void }) => (
    <div data-testid="source-editor">
      <button onClick={() => onDirtyChange?.(true)}>make dirty</button>
    </div>
  ),
}));

import GraphTab from '../GraphTab';

function tab(over: Partial<React.ComponentProps<typeof GraphTab>> = {}) {
  return (
    <GraphTab
      projectId="p1"
      storyGraph={storyGraph}
      inkSource="=== intro ==="
      sourceResetKey={0}
      onStoryUpdated={() => Promise.resolve()}
      onSourceReplaced={vi.fn()}
      {...over}
    />
  );
}

afterEach(() => {
  h.setCenter.mockClear();
  vi.restoreAllMocks();
});

describe('GraphTab jumpRequest', () => {
  it('centres the canvas on the requested passage and reports back', async () => {
    const onJumpHandled = vi.fn();
    const { rerender } = render(tab());
    h.setCenter.mockClear(); // the initial framing centres on the start node
    rerender(tab({ jumpRequest: { nodeId: 'harbour' }, onJumpHandled }));
    await waitFor(() => expect(h.setCenter).toHaveBeenCalled());
    expect(onJumpHandled).toHaveBeenCalled();
  });

  it('does nothing without a request', () => {
    const onJumpHandled = vi.fn();
    render(tab({ onJumpHandled }));
    expect(onJumpHandled).not.toHaveBeenCalled();
  });

  it('acknowledges a passage that is not in the story instead of waiting forever', async () => {
    // An unacknowledged request re-fires the next time this tab
    // mounts — the stale jump onJumpHandled exists to prevent.
    const onJumpHandled = vi.fn();
    const { rerender } = render(tab());
    h.setCenter.mockClear();
    rerender(tab({ jumpRequest: { nodeId: 'deleted_passage' }, onJumpHandled }));
    await waitFor(() => expect(onJumpHandled).toHaveBeenCalled());
    expect(h.setCenter).not.toHaveBeenCalled();
  });

  it('asks before a jump discards an unsaved source draft, and honours a no', async () => {
    // Cmd-K then Enter is a far easier accident than clicking the
    // panel's close button, and the draft goes with the panel. StoryTab
    // has guarded its own view switch this way; GraphTab tore the panel
    // down with no prompt and no undo.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onJumpHandled = vi.fn();
    const { rerender } = render(tab());
    fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
    fireEvent.click(screen.getByRole('button', { name: 'make dirty' }));

    rerender(tab({ jumpRequest: { nodeId: 'harbour' }, onJumpHandled }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    // Declined: the draft survives...
    expect(screen.getByTestId('source-editor')).toBeInTheDocument();
    // ...and the request is still acknowledged, or it re-fires on the
    // next mount as a stale jump.
    expect(onJumpHandled).toHaveBeenCalled();
  });

  it('does not ask when the source panel is clean', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { rerender } = render(tab());
    fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));

    rerender(tab({ jumpRequest: { nodeId: 'harbour' }, onJumpHandled: vi.fn() }));

    await waitFor(() => expect(screen.queryByTestId('source-editor')).toBeNull());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('closes the slide-in source panel so it cannot cover the target', async () => {
    const onJumpHandled = vi.fn();
    const { rerender } = render(tab());
    fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
    expect(screen.getByTestId('source-editor')).toBeInTheDocument();
    rerender(tab({ jumpRequest: { nodeId: 'harbour' }, onJumpHandled }));
    await waitFor(() => expect(screen.queryByTestId('source-editor')).toBeNull());
  });
});
