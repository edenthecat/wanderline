// Keyboard + screen-reader guarantees for the graph canvas.
//
// The graph is the only surface that exposes the per-passage detail
// rail (transcript, character, flags, audio, choice targets), so if
// the canvas is pointer-only the rail is unreachable for anyone who
// doesn't use a mouse. These tests hold the three things that were
// broken: nodes have accessible names, Enter opens the rail, and
// Backspace does not silently remove a passage.

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { StoryGraph, StoryNode } from '../../api/client';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    fetchMetadata: vi.fn().mockResolvedValue({ metadata: {} }),
    fetchAudioAssignments: vi.fn().mockResolvedValue({ assignments: {}, raw: [] }),
    fetchCharacters: vi.fn().mockResolvedValue({ characters: [] }),
    fetchNodeFlags: vi.fn().mockResolvedValue({ total: 0, truncated: false, flags: [] }),
  };
});

// No collab socket in tests — GraphTab only needs the doc to be null.
vi.mock('../../hooks/useYjs', () => ({
  useYjs: () => ({ doc: null, awareness: null, status: 'disconnected' }),
}));
vi.mock('../../hooks/useStoryYDoc', () => ({
  useYjsSeedReady: () => false,
}));

import GraphTab from '../GraphTab';

function node(over: Partial<StoryNode> & { id: string }): StoryNode {
  return {
    type: 'knot',
    parent: null,
    content: [{ text: 'Some prose.', tags: [] }],
    choices: [],
    divert: null,
    tags: [],
    lineNumber: 1,
    ...over,
  };
}

function graph(over: Partial<StoryGraph> = {}): StoryGraph {
  return {
    id: 'g1',
    title: 'Story',
    startNode: '_intro',
    nodes: {
      _intro: node({
        id: '_intro',
        choices: [
          {
            // Longer than the card's 20-char clip, so the accessible
            // name is the only place the full string survives.
            text: 'Follow the light down the corridor',
            target: 'corridor',
            sticky: false,
            fallback: false,
            tags: [],
          },
        ],
      }),
      corridor: node({ id: 'corridor', audio: { voiceover: 'clip-1' } }),
    },
    validation: { valid: true, errors: [], warnings: [] },
    ...over,
  };
}

function renderGraph(storyGraph: StoryGraph = graph()) {
  return render(
    <GraphTab
      projectId="p1"
      storyGraph={storyGraph}
      inkSource=""
      sourceResetKey={0}
      onStoryUpdated={() => Promise.resolve()}
      onSourceReplaced={() => {}}
    />,
  );
}

/** The focusable wrapper React Flow renders around each node. */
function nodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="rf__node-${id}"]`);
  if (!el) throw new Error(`no rendered node for ${id}`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GraphTab keyboard and screen-reader access', () => {
  // role="group" does not take its name from content, so with no
  // ariaLabel every node announces as an identical "group, node".
  it('gives every node an accessible name describing the passage', async () => {
    const { container } = renderGraph();
    await waitFor(() => expect(nodeEl(container, '_intro')).toBeTruthy());

    const intro = nodeEl(container, '_intro').getAttribute('aria-label') ?? '';
    expect(intro).toContain('_intro');
    expect(intro).toContain('start node');
    expect(intro).toContain('no audio assigned');
    // Untruncated choice text + target: the card clips both, and the
    // full string was previously only in a native title= tooltip.
    expect(intro).toContain('Follow the light down the corridor');
    expect(intro).toContain('corridor');

    const corridor = nodeEl(container, 'corridor').getAttribute('aria-label') ?? '';
    expect(corridor).toContain('corridor');
    expect(corridor).toContain('has audio');
    expect(corridor).toContain('no choices');
  });

  it('names validation severity, which the card otherwise shows in colour alone', async () => {
    const g = graph();
    g.validation = {
      valid: false,
      errors: [{ nodeId: 'corridor', message: 'broken' } as never],
      warnings: [],
    };
    const { container } = renderGraph(g);
    await waitFor(() => expect(nodeEl(container, 'corridor')).toBeTruthy());

    expect(nodeEl(container, 'corridor').getAttribute('aria-label')).toContain('validation error');
    // ...and a non-colour marker on the card itself for sighted users.
    // (Queried by selector, not getByRole: jsdom can't measure the
    // canvas, so React Flow leaves every node visibility:hidden and
    // role queries skip them.)
    const marker = nodeEl(container, 'corridor').querySelector('.graph-node-severity');
    expect(marker?.getAttribute('role')).toBe('img');
    expect(marker?.getAttribute('aria-label')).toBe('Validation error');
    expect(marker?.textContent?.trim()).toBeTruthy();
  });

  // A bare <span> maps to `generic`, a role that prohibits naming, so
  // the audio dot's aria-label was dropped by browsers — and the span
  // is empty, so it exposed nothing at all.
  it('exposes the audio dot with a naming-capable role', async () => {
    const { container } = renderGraph();
    await waitFor(() => expect(nodeEl(container, 'corridor')).toBeTruthy());

    const dot = nodeEl(container, 'corridor').querySelector('.graph-node-dot');
    expect(dot?.getAttribute('role')).toBe('img');
    expect(dot?.getAttribute('aria-label')).toBe('has audio');

    const offDot = nodeEl(container, '_intro').querySelector('.graph-node-dot');
    expect(offDot?.getAttribute('aria-label')).toBe('no audio assigned');
  });

  // React Flow makes nodes focusable and binds Enter/Space, but its
  // handler only flips selection in its own store — the onNodeClick
  // prop is invoked from the DOM click path alone. Enter used to add
  // `is-selected` and nothing more.
  it('opens the detail rail when Enter is pressed on a focused node', async () => {
    const { container } = renderGraph();
    await waitFor(() => expect(nodeEl(container, 'corridor')).toBeTruthy());
    expect(screen.queryByRole('complementary', { name: /Node detail/ })).toBeNull();

    const el = nodeEl(container, 'corridor');
    el.focus();
    fireEvent.keyDown(el, { key: 'Enter' });

    const rail = await screen.findByRole('complementary', { name: 'Node detail: corridor' });
    expect(rail).toBeTruthy();
    // Focus follows the rail open, otherwise the user has to tab back
    // through the whole canvas to reach the controls they just opened.
    await waitFor(() => expect(document.activeElement).toBe(rail));
  });

  it('hands focus back to the node when the rail is closed', async () => {
    const { container } = renderGraph();
    await waitFor(() => expect(nodeEl(container, 'corridor')).toBeTruthy());

    const el = nodeEl(container, 'corridor');
    el.focus();
    fireEvent.keyDown(el, { key: 'Enter' });
    await screen.findByRole('complementary', { name: 'Node detail: corridor' });

    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    await waitFor(() => expect(document.activeElement).toBe(nodeEl(container, 'corridor')));
  });

  // React Flow's default deleteKeyCode is 'Backspace'. With a node
  // focused that removed the card from the local node list — nothing
  // was deleted server-side, and the re-seed effect is keyed on the
  // (unchanged) storyGraph, so it never came back.
  it('does not remove a passage when Backspace is pressed on a node', async () => {
    const { container } = renderGraph();
    await waitFor(() => expect(nodeEl(container, 'corridor')).toBeTruthy());
    // Let the metadata / character / flag fetches settle first. Each
    // one re-runs the layout memo, and the re-seed effect would put a
    // locally-removed node back — masking the bug.
    await act(() => new Promise((r) => setTimeout(r, 50)));

    const el = nodeEl(container, 'corridor');
    // Select it the way reaching it from the keyboard does — React
    // Flow's own Enter handler flips selection in its store.
    el.focus();
    fireEvent.keyDown(el, { key: 'Enter' });
    // React Flow's key tracking keeps a set of held keys, so the
    // matching keyup matters: without it Backspace reads as the
    // combination Enter+Backspace and matches nothing.
    fireEvent.keyUp(el, { key: 'Enter' });
    await waitFor(() => expect(nodeEl(container, 'corridor').className).toContain('selected'));

    fireEvent.keyDown(document, { key: 'Backspace' });
    fireEvent.keyUp(document, { key: 'Backspace' });

    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="rf__node-corridor"]')).toBeTruthy();
  });
});
