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
function renderPanel(initial: Record<string, client.NodeFlag[]>, truncated = false) {
  const panel = (flags: Record<string, client.NodeFlag[]>, capped: boolean) => (
    <FlaggedNodesPanel
      projectId="p1"
      flagsByNode={flags}
      nodeIdSet={new Set(Object.keys(flags))}
      onJumpToNode={vi.fn()}
      onFlagsChanged={vi.fn()}
      truncated={capped}
    />
  );
  const view = render(panel(initial, truncated));
  const update = (next: Record<string, client.NodeFlag[]>, capped = false) =>
    view.rerender(panel(next, capped));
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
    expect(screen.getByTestId('flagged-panel-status').textContent).toBe('Flag resolved.');
  });

  it('hands focus back to the button when the resolve fails', async () => {
    // A real browser blurs an element the moment it becomes disabled,
    // so the in-flight Resolve button drops focus to <body> on its own.
    // jsdom won't reproduce that — `blur()` is a no-op on a disabled
    // element there — so focus is moved away by hand while the request
    // is in flight. Without that, the button never loses focus and this
    // test would pass with or without the fix.
    let fail!: (e: Error) => void;
    vi.spyOn(client, 'resolveNodeFlag').mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
    );
    renderPanel({ her: [flag({ id: 'a' }), flag({ id: 'b' })] });
    expand();

    const [first] = resolveButtons();
    first.focus();
    fireEvent.click(first);

    await waitFor(() => expect(first).toBeDisabled());
    const elsewhere = screen.getByRole('button', { expanded: true });
    elsewhere.focus();
    expect(document.activeElement).not.toBe(first);

    await act(async () => {
      fail(new Error('Already resolved'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Already resolved'));
    expect(document.activeElement).toBe(resolveButtons()[0]);
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

  it('hedges the spoken count when the server capped the list', async () => {
    const { update } = renderPanel({ her: [flag({ id: 'a' }), flag({ id: 'b' })] }, true);
    update({ her: [flag({ id: 'b' })] }, true);
    await waitFor(() =>
      expect(screen.getByTestId('flagged-panel-status').textContent).toBe(
        '1 open flag across 1 passage, showing the most recent.',
      ),
    );
  });

  it('does not claim the queue is clear when the flags fetch merely failed', async () => {
    // useNodeEditor swallows a failed GET by reporting `{}`, which is
    // indistinguishable from "nothing outstanding". Saying "resolved"
    // there would tell an author their review queue is clear when
    // nothing was resolved at all.
    const { update } = renderPanel({ her: [flag({ id: 'a' }), flag({ id: 'b' })] });
    update({});
    await waitFor(() => expect(screen.queryByTestId('flagged-panel')).toBeNull());
    expect(screen.getByTestId('flagged-panel-status').textContent).toBe('');
  });

  it('leaves focus alone when the author has already moved on', async () => {
    // The refetch can land a second or two after the click. By then the
    // author may be typing in the source editor, and yanking focus onto
    // a Resolve button mid-keystroke would put their next Space or
    // Enter on an unrelated flag.
    vi.spyOn(client, 'resolveNodeFlag').mockResolvedValue(undefined as never);
    const outside = document.createElement('button');
    outside.textContent = 'Ink source';
    document.body.appendChild(outside);
    try {
      const { update } = renderPanel({
        her: [flag({ id: 'a' }), flag({ id: 'b' }), flag({ id: 'c' })],
      });
      expand();

      const [first] = resolveButtons();
      first.focus();
      await act(async () => {
        fireEvent.click(first);
      });
      outside.focus();

      update({ her: [flag({ id: 'b' }), flag({ id: 'c' })] });
      await waitFor(() => expect(resolveButtons()).toHaveLength(2));
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it('does not spend the resolve credit on a later empty list', async () => {
    // Resolving one flag while a collaborator raises another leaves the
    // total flat — and the summary string with it. The credit for that
    // resolve has to be spent on the refetch that carried it, or it
    // survives to be attached to the next empty list, which is also
    // what a failed fetch looks like.
    vi.spyOn(client, 'resolveNodeFlag').mockResolvedValue(undefined as never);
    const { update } = renderPanel({ her: [flag({ id: 'a' }), flag({ id: 'b' })] });
    expand();

    const [first] = resolveButtons();
    await act(async () => {
      fireEvent.click(first);
    });

    // 'a' resolved, 'c' raised elsewhere: two flags before, two after.
    update({ her: [flag({ id: 'b' }), flag({ id: 'c' })] });
    await waitFor(() => expect(resolveButtons()).toHaveLength(2));
    // Silence here would read as "your click did nothing".
    expect(screen.getByTestId('flagged-panel-status').textContent).toBe(
      'Flag resolved. 2 open flags across 1 passage.',
    );

    // Now the flags fetch drops and reports `{}`.
    update({});
    await waitFor(() => expect(screen.queryByTestId('flagged-panel')).toBeNull());
    expect(screen.getByTestId('flagged-panel-status').textContent).toBe('');
  });

  it('carries two overlapping resolves through to focus and speech', async () => {
    // `resolving` is a Set on purpose: a second resolve can start while
    // the first is in flight, and each refetch removes one row. A
    // single-slot record would let the second resolve overwrite the
    // first, then be spent by the first refetch — leaving the removal
    // that empties the list with nothing queued and nothing to say.
    vi.spyOn(client, 'resolveNodeFlag').mockResolvedValue(undefined as never);
    const { update } = renderPanel({ her: [flag({ id: 'a' }), flag({ id: 'b' })] });
    expand();

    const [ra, rb] = resolveButtons();
    ra.focus();
    await act(async () => {
      fireEvent.click(ra);
    });
    rb.focus();
    await act(async () => {
      fireEvent.click(rb);
    });

    update({ her: [flag({ id: 'b' })] });
    await waitFor(() => expect(resolveButtons()).toHaveLength(1));

    update({});
    await waitFor(() => expect(screen.queryByTestId('flagged-panel')).toBeNull());
    // The author cleared their whole queue; silence here would be the
    // bug the announcement exists to fix.
    expect(screen.getByTestId('flagged-panel-status').textContent).toBe('Flag resolved.');
  });

  it('does not move focus for a click that never focused the button', async () => {
    // Safari leaves activeElement on <body> after a mouse click on a
    // button — the same place a disable-blur leaves it. Moving focus
    // onto the next Resolve button there would put the mouse user's
    // next Space, pressed to scroll, on a flag they never read.
    vi.spyOn(client, 'resolveNodeFlag').mockResolvedValue(undefined as never);
    const { update } = renderPanel({ her: [flag({ id: 'a' }), flag({ id: 'b' })] });
    expand();

    const [first] = resolveButtons();
    // No .focus() — the click arrives with focus still on <body>.
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      fireEvent.click(first);
    });
    update({ her: [flag({ id: 'b' })] });

    await waitFor(() => expect(resolveButtons()).toHaveLength(1));
    expect(document.activeElement).toBe(document.body);
  });

  it('still reports a failure when the list empties in the same breath', async () => {
    // A collaborator clears the last flag while the author's Resolve
    // for it is in flight: the request 404s at the same moment the
    // refetch reports `{}`. If the alert went away with the panel the
    // click would have produced no outcome at all.
    vi.spyOn(client, 'resolveNodeFlag').mockRejectedValue(new Error('Already resolved'));
    const { update } = renderPanel({ her: [flag({ id: 'a' })] });
    expand();

    await act(async () => {
      fireEvent.click(resolveButtons()[0]);
    });
    update({});

    await waitFor(() => expect(screen.queryByTestId('flagged-panel')).toBeNull());
    expect(screen.getByRole('alert')).toHaveTextContent('Already resolved');
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
