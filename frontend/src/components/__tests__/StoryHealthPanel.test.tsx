import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StoryHealthPanel from '../StoryHealthPanel';
import type { StoryGraph, StoryNode } from '../../api/client';

function node(id: string, over: Partial<StoryNode> = {}): StoryNode {
  return {
    id,
    type: 'knot',
    parent: null,
    content: [],
    choices: [],
    divert: null,
    tags: [],
    lineNumber: 1,
    ...over,
  };
}

const graph: StoryGraph = {
  id: 'g1',
  title: 'Story',
  startNode: 'start',
  nodes: {
    start: node('start', { divert: 'END', tags: ['ending'] }),
    lonely: node('lonely', { divert: 'END' }),
  },
  validation: { valid: true, errors: [], warnings: [] },
};

describe('StoryHealthPanel', () => {
  it('stays collapsed on an ordinary visit', () => {
    render(<StoryHealthPanel storyGraph={graph} onJumpToNode={vi.fn()} />);
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy();
    expect(screen.queryByText('Unreachable nodes')).toBeNull();
  });

  // Arriving from the Ship tab's readiness summary means someone
  // clicked "1 unreachable knot" and asked to see which. Landing on a
  // collapsed one-line strip they still have to open is not an answer.
  it('arrives already open when the reader was sent here for the count', () => {
    render(<StoryHealthPanel storyGraph={graph} onJumpToNode={vi.fn()} startExpanded />);
    expect(screen.getByText('Unreachable nodes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'lonely' })).toBeTruthy();
  });
});
