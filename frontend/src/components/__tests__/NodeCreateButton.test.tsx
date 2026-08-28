import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NodeCreateButton from '../NodeCreateButton';

// Where a new passage lands is a story decision in Ink: a passage that
// ends without a divert falls through to the NEXT sibling. The form has
// to be able to say "after this one", and a stitch has to reach the
// server as `knot.name`.

describe('NodeCreateButton', () => {
  it('creates a top-level node, appended by default', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <NodeCreateButton
        label="knot"
        onCreate={onCreate}
        nodeIdSet={new Set(['intro'])}
        siblings={['intro']}
      />,
    );
    fireEvent.click(screen.getByText('+ knot'));
    fireEvent.change(screen.getByLabelText('knot'), { target: { value: 'chapter2' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('chapter2', undefined));
  });

  it('qualifies a stitch name with its knot and passes the placement', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <NodeCreateButton
        label="stitch"
        parentId="ch1"
        siblings={['ch1.a', 'ch1.b']}
        onCreate={onCreate}
        nodeIdSet={new Set(['ch1', 'ch1.a', 'ch1.b'])}
      />,
    );
    fireEvent.click(screen.getByText('+ stitch'));
    fireEvent.change(screen.getByLabelText('stitch'), { target: { value: 'mid' } });
    fireEvent.change(screen.getByLabelText(/Place after/), { target: { value: 'ch1.a' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('ch1.mid', { afterNodeId: 'ch1.a' }));
  });

  it('catches a duplicate id before the round-trip', async () => {
    const onCreate = vi.fn();
    render(
      <NodeCreateButton
        label="stitch"
        parentId="ch1"
        onCreate={onCreate}
        nodeIdSet={new Set(['ch1', 'ch1.a'])}
      />,
    );
    fireEvent.click(screen.getByText('+ stitch'));
    fireEvent.change(screen.getByLabelText('stitch'), { target: { value: 'a' } });
    fireEvent.click(screen.getByText('Add'));
    expect(await screen.findByRole('alert')).toHaveTextContent('"ch1.a" already exists.');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('surfaces the server error inline and keeps the form open', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('Knot "ghost" does not exist'));
    render(
      <NodeCreateButton
        label="stitch"
        parentId="ghost"
        onCreate={onCreate}
        nodeIdSet={new Set()}
      />,
    );
    fireEvent.click(screen.getByText('+ stitch'));
    fireEvent.change(screen.getByLabelText('stitch'), { target: { value: 'scene' } });
    fireEvent.click(screen.getByText('Add'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Knot "ghost" does not exist');
    expect(screen.getByLabelText('stitch')).toBeTruthy();
  });
});
