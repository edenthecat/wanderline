// Cheap axe coverage for the editor's other author-facing strips.
//
// These weren't in the audit's findings — this is the regression net,
// so the next person to add a badge, a toggle or a glyph to one of
// them finds out here rather than from a listener. See test-a11y.ts
// for what axe does and does not see.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import StoryHealthPanel from '../StoryHealthPanel';
import FlagNodeControl from '../FlagNodeControl';
import type { StoryGraph, StoryNode } from '../../api/client';
import { expectNoAxeViolations } from '../../test-a11y';

const node = (id: string, over: Partial<StoryNode> = {}): StoryNode => ({
  id,
  type: 'knot',
  parent: null,
  content: [{ text: `${id} says something.`, tags: [] }],
  choices: [],
  divert: null,
  tags: [],
  lineNumber: 1,
  ...over,
});

const graph = (): StoryGraph => ({
  id: 'g1',
  title: 'A Story',
  nodes: {
    // start diverts onward; attic is reachable from nowhere; cellar is
    // a dead end. One of each signal the panel reports.
    start: node('start', { divert: 'cellar' }),
    cellar: node('cellar'),
    attic: node('attic'),
  },
  startNode: 'start',
  validation: { valid: true, errors: [], warnings: [] },
});

describe('editor surface accessibility', () => {
  it('StoryHealthPanel has no axe violations, collapsed or expanded', async () => {
    const { container } = render(<StoryHealthPanel storyGraph={graph()} onJumpToNode={vi.fn()} />);
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await expectNoAxeViolations(container);
  });

  it('FlagNodeControl has no axe violations, closed or with the form open', async () => {
    const { container } = render(
      <FlagNodeControl projectId="p1" nodeId="her" onFlagged={vi.fn()} />,
    );
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole('button', { name: /flag/i }));
    await expectNoAxeViolations(container);
  });
});
