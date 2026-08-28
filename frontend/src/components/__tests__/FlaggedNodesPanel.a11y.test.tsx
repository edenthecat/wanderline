// Resolving a flag deletes the row its own button lives in. Nothing
// re-homed focus, so it fell to <body>: working through three flags
// meant being thrown to the top of the document three times, with the
// badge count changing silently each time.

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FlaggedNodesPanel from '../FlaggedNodesPanel';
import * as client from '../../api/client';
import { expectNoAxeViolations } from '../../test-a11y';

const flag = (over: Partial<client.NodeFlag> = {}): client.NodeFlag => ({
  id: 'fl1',
  nodeId: 'her',
  reason: 'incorrect_audio',
  note: null,
  createdAt: '2026-08-27T10:00:00Z',
  resolvedAt: null,
  createdByName: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

/**
 * A panel wired the way StoryTab wires it: `onFlagsChanged` refetches,
 * and the refreshed `flagsByNode` arrives as a new prop.
 */
function renderPanel(initial: Record<string, client.NodeFlag[]>) {
  let flags = initial;
  const view = render(
    <FlaggedNodesPanel
      projectId="p1"
      flagsByNode={flags}
      nodeIdSet={new Set(Object.keys(flags))}
      onJumpToNode={vi.fn()}
      onFlagsChanged={vi.fn()}
      truncated={false}
    />,
  );
  const update = (next: Record<string, client.NodeFlag[]>) => {
    flags = next;
    view.rerender(
      <FlaggedNodesPanel
        projectId="p1"
        flagsByNode={flags}
        nodeIdSet={new Set(Object.keys(flags))}
        onJumpToNode={vi.fn()}
        onFlagsChanged={vi.fn()}
        truncated={false}
      />,
    );
  };
  return { ...view, update };
}

const expand = () => fireEvent.click(screen.getByRole('button', { expanded: false }));
const resolveButtons = () => screen.getAllByRole('button', { name: /^Resolve / });

describe('FlaggedNodesPanel accessibility', () => {
  it('moves focus to the next Resolve button when a row removes itself', async () => {
    vi.spyOn(client, 'resolveNodeFlag').mockResolvedValue(undefined as never);
    const { update } = renderPanel({
      her: [flag({ id: 'a' }), flag({ id: 'b' }), flag({ id: 'c' })],
    });
    expand();

    const [first] = resolveButtons();
    first.focus();
    await act(async () => {
      fireEvent.click(first);
    });
    // The refetch lands and 'a' is gone.
    update({ her: [flag({ id: 'b' }), flag({ id: 'c' })] });

    await waitFor(() => {
      expect(document.activeElement).toBe(resolveButtons()[0]);
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  it('steps back up when the last row in the list is the one removed', async () => {
    vi.spyOn(client, 'resolveNodeFlag').mockResolvedValue(undefined as never);
    const { update } = renderPanel({ her: [flag({ id: 'a' }), flag({ id: 'b' })] });
    expand();

    const buttons = resolveButtons();
    const last = buttons[buttons.length - 1];
    last.focus();
    await act(async () => {
      fireEvent.click(last);
    });
    update({ her: [flag({ id: 'a' })] });

    await waitFor(() => {
      const remaining = resolveButtons();
      expect(document.activeElement).toBe(remaining[remaining.length - 1]);
    });
  });

  it('lands somewhere real when the last flag on the project is resolved', async () => {
    vi.spyOn(client, 'resolveNodeFlag').mockResolvedValue(undefined as never);
    const { update } = renderPanel({ her: [flag({ id: 'a' })] });
    expand();

    const [only] = resolveButtons();
    only.focus();
    await act(async () => {
      fireEvent.click(only);
    });
    update({});

    // The whole panel unmounts — the status line is what's left, and
    // it says what happened.
    await waitFor(() => {
      expect(screen.queryByTestId('flagged-panel')).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId('flagged-panel-status'));
    });
    expect(screen.getByTestId('flagged-panel-status').textContent).toBe('All flags resolved.');
  });

  it('reports the open-flag count as it changes', async () => {
    const { update } = renderPanel({ her: [flag({ id: 'a' }), flag({ id: 'b' })] });
    const status = screen.getByTestId('flagged-panel-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    // Silent on arrival.
    expect(status.textContent).toBe('');

    update({ her: [flag({ id: 'b' })] });
    await waitFor(() => expect(status.textContent).toBe('1 open flag across 1 passage.'));
  });

  it('has no axe violations, collapsed or expanded', async () => {
    const { container } = renderPanel({
      her: [flag({ id: 'a', note: 'wrong take' })],
      gone: [flag({ id: 'b', nodeId: 'gone' })],
    });
    await expectNoAxeViolations(container);
    expand();
    await expectNoAxeViolations(container);
  });
});
