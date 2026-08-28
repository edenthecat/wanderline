import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FlaggedNodesPanel from '../FlaggedNodesPanel';
import * as client from '../../api/client';

// The per-passage badges answer "is this one flagged?". This answers
// "what's outstanding on this story?" — the question you have when you
// sit down to work through a review.

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

function panel(over: Partial<React.ComponentProps<typeof FlaggedNodesPanel>> = {}) {
  return (
    <FlaggedNodesPanel
      projectId="p1"
      flagsByNode={{ her: [flag()] }}
      nodeIdSet={new Set(['her'])}
      onJumpToNode={vi.fn()}
      onFlagsChanged={vi.fn()}
      {...over}
    />
  );
}

afterEach(() => vi.restoreAllMocks());

describe('FlaggedNodesPanel', () => {
  // A panel reporting zero would just be furniture above the story.
  it('renders nothing when there are no open flags', () => {
    const { container } = render(panel({ flagsByNode: {} }));
    expect(container.querySelector('.flagged-panel')).toBeNull();
  });

  it('summarises the count across passages without expanding', () => {
    render(
      panel({
        flagsByNode: { her: [flag(), flag({ id: 'fl2' })], sam: [flag({ id: 'fl3' })] },
        nodeIdSet: new Set(['her', 'sam']),
      }),
    );
    expect(screen.getByText('3 open flags')).toBeTruthy();
    expect(screen.getByText(/across 2 passages/)).toBeTruthy();
  });

  // Arriving from the Ship tab's readiness summary means someone
  // clicked a count and asked to see it. Landing on a collapsed
  // one-line strip they still have to open is not an answer.
  it('arrives already open when the reader was sent here for the count', () => {
    render(panel({ flagsByNode: { her: [flag({ note: 'wrong take' })] }, startExpanded: true }));
    expect(screen.getByText('wrong take')).toBeTruthy();
  });

  it('lists each flag once expanded', () => {
    render(panel({ flagsByNode: { her: [flag({ note: 'wrong take' })] } }));
    fireEvent.click(screen.getByText('1 open flag'));
    expect(screen.getByText('Incorrect audio')).toBeTruthy();
    expect(screen.getByText('wrong take')).toBeTruthy();
  });

  it('jumps to the passage', () => {
    const onJumpToNode = vi.fn();
    render(panel({ onJumpToNode }));
    fireEvent.click(screen.getByText('1 open flag'));
    fireEvent.click(screen.getByLabelText('Jump to her'));
    expect(onJumpToNode).toHaveBeenCalledWith('her');
  });

  // A flag on a passage the story no longer has can't be jumped to and
  // can't be fixed in place — it needs a decision, so it's called out
  // and sorted to the top rather than left looking like the others.
  it('calls out a flag whose passage no longer exists', () => {
    render(panel({ flagsByNode: { ghost: [flag({ nodeId: 'ghost' })] }, nodeIdSet: new Set() }));
    fireEvent.click(screen.getByText('1 open flag'));
    expect(screen.getByText('no longer in story')).toBeTruthy();
    expect(screen.queryByLabelText('Jump to ghost')).toBeNull();
  });

  it('sorts orphaned passages first', () => {
    render(
      panel({
        flagsByNode: { her: [flag()], ghost: [flag({ id: 'fl2', nodeId: 'ghost' })] },
        nodeIdSet: new Set(['her']),
      }),
    );
    fireEvent.click(screen.getByText('2 open flags'));
    const codes = Array.from(document.querySelectorAll('.flagged-panel-node code')).map(
      (n) => n.textContent,
    );
    expect(codes[0]).toBe('ghost');
  });

  it('resolves from the list and tells the parent to refresh', async () => {
    const resolve = vi.spyOn(client, 'resolveNodeFlag').mockResolvedValue({ resolved: true });
    const onFlagsChanged = vi.fn();
    render(panel({ onFlagsChanged }));
    fireEvent.click(screen.getByText('1 open flag'));
    fireEvent.click(screen.getByLabelText('Resolve Incorrect audio on her'));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('p1', 'fl1'));
    await waitFor(() => expect(onFlagsChanged).toHaveBeenCalled());
  });

  // Gating every button on one in-flight id meant starting a second
  // resolve re-enabled the first — letting it fire twice and surface
  // the backend's "already resolved" 404 for an action that had
  // actually succeeded — while finishing the first wiped the second's
  // spinner.
  it('tracks concurrent resolves independently', async () => {
    let releaseA: (() => void) | undefined;
    vi.spyOn(client, 'resolveNodeFlag').mockImplementation((_p, flagId) =>
      flagId === 'fl1'
        ? new Promise((res) => {
            releaseA = () => res({ resolved: true });
          })
        : Promise.resolve({ resolved: true }),
    );
    render(
      panel({
        flagsByNode: { her: [flag(), flag({ id: 'fl2', reason: 'needs_text_edit' })] },
      }),
    );
    fireEvent.click(screen.getByText('2 open flags'));

    const a = screen.getByLabelText('Resolve Incorrect audio on her') as HTMLButtonElement;
    const b = screen.getByLabelText('Resolve Needs a text edit on her') as HTMLButtonElement;

    fireEvent.click(a);
    await waitFor(() => expect(a.disabled).toBe(true));
    fireEvent.click(b);

    // B in flight must not re-enable A.
    expect(a.disabled).toBe(true);
    // And B finishing must not clear A's spinner.
    await waitFor(() => expect(b.disabled).toBe(false));
    expect(a.disabled).toBe(true);

    releaseA?.();
    await waitFor(() => expect(a.disabled).toBe(false));
  });

  // The cap must not masquerade as the total.
  it('says when the list is capped', () => {
    render(panel({ truncated: true }));
    expect(screen.getByText(/showing the most recent/)).toBeTruthy();
  });
});
