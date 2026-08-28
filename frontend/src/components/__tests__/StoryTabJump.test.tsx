// The Story-tab end of the ⌘K handoff: a jump request expands and
// scrolls to the passage, brings the Nodes view back if the author
// was in the raw Source editor, and doesn't throw away an unsaved
// draft to do it.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryGraph, StoryNode } from '../../api/client';

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

vi.mock('../../api/client', () => ({
  uploadInk: vi.fn(),
  uploadInkJson: vi.fn(),
  uploadTwee: vi.fn(),
  exportStorySource: vi.fn(() => Promise.resolve('')),
}));

vi.mock('../../hooks/useYjs', () => ({ useYjs: () => ({ doc: null }) }));
vi.mock('../../hooks/useStoryYDoc', () => ({ useYjsSeedReady: () => true }));
vi.mock('../../hooks/useNodeEditor', () => ({
  useNodeEditor: () => ({
    metadata: {},
    metadataLoaded: true,
    audioByNode: {},
    audioNames: {},
    characters: [],
    flagsByNode: {},
    flagsTruncated: false,
    refreshFlags: vi.fn(),
    metadataError: null,
    retryMetadata: vi.fn(),
    nodeIdSet: new Set(['intro', 'harbour']),
    nodeIdOptions: ['intro', 'harbour'],
    reverseEdges: new Map(),
    handleChoiceTextEdit: vi.fn(),
    handleNodeContentEdit: vi.fn(),
    handleChoiceTargetEdit: vi.fn(),
    handleDivertEdit: vi.fn(),
    handleAddChoice: vi.fn(),
    handleDeleteChoice: vi.fn(),
    handleSwapChoices: vi.fn(),
    handleRenameNode: vi.fn(),
    handleMetadataSave: vi.fn(),
    editorError: null,
    clearEditorError: vi.fn(),
  }),
}));

// The real source editors are CodeMirror; this stub keeps the dirty
// signal (the only thing this suite cares about) and nothing else.
vi.mock('../InkSourceEditor', () => ({
  default: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => (
    <button onClick={() => onDirtyChange(true)}>make draft dirty</button>
  ),
}));
vi.mock('../TweeSourceEditor', () => ({ default: () => <div /> }));
vi.mock('../NodeDetail', () => ({ default: () => <div />, hasCustomTiming: () => false }));
vi.mock('../NodeRenameButton', () => ({ default: () => <div /> }));

import StoryTab from '../StoryTab';

function tab(over: Partial<React.ComponentProps<typeof StoryTab>> = {}) {
  return (
    <StoryTab
      projectId="p1"
      storyGraph={storyGraph}
      inkSource="=== intro ==="
      tweeSource={null}
      sourceLanguage="ink"
      nomenclaturePreference="auto"
      sourceResetKey={0}
      onStoryUpdated={() => Promise.resolve()}
      onSourceReplaced={vi.fn()}
      otherPresence={[]}
      onSelfEditingNodeChange={vi.fn()}
      {...over}
    />
  );
}

function renderTab(over: Partial<React.ComponentProps<typeof StoryTab>> = {}) {
  const onJumpHandled = vi.fn();
  const utils = render(tab({ onJumpHandled, ...over }));
  return { ...utils, onJumpHandled };
}

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  // jsdom has no scrollIntoView; StoryTab's jump path calls it.
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => vi.restoreAllMocks());

const knotToggle = (id: string) =>
  screen.getByRole('button', { name: new RegExp(`(Expand|Collapse) ${id}`) });

describe('StoryTab jumpRequest', () => {
  it('expands and scrolls to the requested passage, then reports back', async () => {
    const { onJumpHandled } = renderTab({ jumpRequest: { nodeId: 'harbour' } });
    await waitFor(() => expect(knotToggle('harbour')).toHaveAttribute('aria-expanded', 'true'));
    expect(knotToggle('intro')).toHaveAttribute('aria-expanded', 'false');
    expect(scrollIntoView).toHaveBeenCalled();
    expect(onJumpHandled).toHaveBeenCalled();
  });

  it('does nothing without a request', () => {
    const { onJumpHandled } = renderTab();
    expect(knotToggle('harbour')).toHaveAttribute('aria-expanded', 'false');
    expect(onJumpHandled).not.toHaveBeenCalled();
  });

  it('brings the Nodes view back when the author was in the Source editor', async () => {
    const { rerender, ...utils } = renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.queryByRole('button', { name: /Expand harbour/ })).toBeNull();
    rerender(tab({ jumpRequest: { nodeId: 'harbour' }, onJumpHandled: utils.onJumpHandled }));
    await waitFor(() => expect(knotToggle('harbour')).toHaveAttribute('aria-expanded', 'true'));
  });

  it('stops asking once the draft is gone', async () => {
    // The source editors report dirty only on a transition and never
    // report clean on unmount, so leaving the view used to strand the
    // flag and raise a phantom confirm over an editor that no longer
    // has anything unsaved.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const utils = renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'make draft dirty' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nodes' }));
    // Back into a fresh editor with nothing typed into it.
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    utils.rerender(tab({ jumpRequest: { nodeId: 'harbour' }, onJumpHandled: utils.onJumpHandled }));
    await waitFor(() => expect(knotToggle('harbour')).toHaveAttribute('aria-expanded', 'true'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('asks before discarding an unsaved source draft, and honours a no', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const utils = renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'make draft dirty' }));
    utils.rerender(tab({ jumpRequest: { nodeId: 'harbour' }, onJumpHandled: utils.onJumpHandled }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    // Still in the Source view, draft intact.
    expect(screen.getByRole('button', { name: 'make draft dirty' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Expand harbour/ })).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
