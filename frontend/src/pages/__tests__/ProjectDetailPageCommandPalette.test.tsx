// The palette's whole promise is "from any tab". That promise lives
// in ProjectDetailPage — it owns the shortcut, the active tab, and
// the one-shot jump request handed to whichever tab takes over — so
// it's tested here with the tabs themselves stubbed out.

import { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDetail, StoryGraph, StoryNode } from '../../api/client';

const h = vi.hoisted(() => ({
  storyJumps: [] as (string | undefined)[],
  graphJumps: [] as (string | undefined)[],
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

const project: ProjectDetail = {
  id: 'p1',
  name: 'Test project',
  description: null,
  owner_id: null,
  story_graph: storyGraph,
  ink_source: null,
  twee_source: null,
  source_language: 'ink',
  settings: null,
  created_at: '2026-08-27T10:00:00Z',
  updated_at: '2026-08-27T10:00:00Z',
};

vi.mock('../../api/client', () => ({
  fetchProject: vi.fn(() => Promise.resolve({ project })),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'p1' }),
  Link: ({ children, ...rest }: React.ComponentProps<'a'>) => <a {...rest}>{children}</a>,
}));

vi.mock('../../hooks/useYjs', () => ({ useYjs: () => ({ doc: null, awareness: null }) }));
vi.mock('../../hooks/useYjsUndo', () => ({ useYjsUndo: () => {} }));
vi.mock('../../hooks/usePresence', () => ({ usePresence: () => [] }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

// Stub tabs: record the jump they were handed and acknowledge it the
// way the real ones do.
function stubTab(name: 'story' | 'graph', sink: (string | undefined)[]) {
  return function StubTab({
    jumpRequest,
    onJumpHandled,
  }: {
    jumpRequest?: { nodeId: string } | null;
    onJumpHandled?: () => void;
  }) {
    useEffect(() => {
      if (!jumpRequest) return;
      sink.push(jumpRequest.nodeId);
      onJumpHandled?.();
    }, [jumpRequest, onJumpHandled]);
    return <div data-testid={`${name}-tab`} />;
  };
}

vi.mock('../../components/StoryTab', () => ({ default: stubTab('story', h.storyJumps) }));
vi.mock('../../components/GraphTab', () => ({ default: stubTab('graph', h.graphJumps) }));
vi.mock('../../components/AudioTab', () => ({ default: () => <div /> }));
vi.mock('../../components/MusicTab', () => ({ default: () => <div /> }));
vi.mock('../../components/CharactersTab', () => ({ default: () => <div /> }));
vi.mock('../../components/BuildsTab', () => ({ default: () => <div /> }));
vi.mock('../../components/HistoryTab', () => ({ default: () => <div /> }));
vi.mock('../../components/SettingsTab', () => ({ default: () => <div /> }));
vi.mock('../../components/PreviewTab', () => ({ default: () => <div /> }));
vi.mock('../../components/ThemeTab', () => ({ default: () => <div /> }));
vi.mock('../../components/VolumesTab', () => ({ default: () => <div /> }));
vi.mock('../../components/SystemSoundsTab', () => ({ default: () => <div /> }));
vi.mock('../../components/HeadphoneControlsTab', () => ({ default: () => <div /> }));
vi.mock('../../components/PlayerDisplayTab', () => ({ default: () => <div /> }));
vi.mock('../../components/YjsDemoField', () => ({ default: () => <div /> }));
vi.mock('../../components/EditableProjectTitle', () => ({
  default: ({ name }: { name: string }) => <h1>{name}</h1>,
}));

import ProjectDetailPage from '../ProjectDetailPage';

async function renderPage() {
  render(<ProjectDetailPage />);
  await waitFor(() => expect(screen.getByTestId('story-tab')).toBeInTheDocument());
}

// The chord is platform-gated (⌘K on Apple, Ctrl-K elsewhere) and
// jsdom reports an empty navigator.platform, so Ctrl is the chord
// here. One test below pins the Mac side.
function pressCommandK() {
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
}

const palette = () => screen.queryByTestId('command-palette');

beforeEach(() => {
  h.storyJumps.length = 0;
  h.graphJumps.length = 0;
});

describe('ProjectDetailPage ⌘K palette', () => {
  it('opens on ⌘K when the author is on a Mac', async () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
    Object.defineProperty(window.navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    try {
      await renderPage();
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
      expect(palette()).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(window.navigator, 'platform', original);
      else delete (window.navigator as { platform?: string }).platform;
    }
  });

  it('is closed until the chord is pressed, and toggles back shut', async () => {
    await renderPage();
    expect(palette()).toBeNull();
    pressCommandK();
    expect(palette()).toBeInTheDocument();
    pressCommandK();
    expect(palette()).toBeNull();
  });

  it('jumps to a passage in the Story tab', async () => {
    await renderPage();
    pressCommandK();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'harbour' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(palette()).toBeNull();
    await waitFor(() => expect(h.storyJumps).toEqual(['harbour']));
  });

  it('switches from another tab back to Story to make the jump', async () => {
    await renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]);
    expect(screen.queryByTestId('story-tab')).toBeNull();
    pressCommandK();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'intro' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('story-tab')).toBeInTheDocument());
    expect(h.storyJumps).toEqual(['intro']);
  });

  it('stays in the Graph tab when that is where the author is working', async () => {
    await renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Graph' })[0]);
    pressCommandK();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'harbour' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    await waitFor(() => expect(h.graphJumps).toEqual(['harbour']));
    expect(screen.getByTestId('graph-tab')).toBeInTheDocument();
    expect(h.storyJumps).toEqual([]);
  });

  it('does not re-fire a stale jump when the author returns to the tab', async () => {
    await renderPage();
    pressCommandK();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'harbour' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    await waitFor(() => expect(h.storyJumps).toEqual(['harbour']));
    // Leave and come back: StoryTab re-mounts, and a jump request the
    // parent had never cleared would fire all over again.
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Story' })[0]);
    await waitFor(() => expect(screen.getByTestId('story-tab')).toBeInTheDocument());
    expect(h.storyJumps).toEqual(['harbour']);
  });
});
