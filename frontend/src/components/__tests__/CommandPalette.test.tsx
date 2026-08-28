import { useRef, useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CommandPalette from '../CommandPalette';
import type { StoryGraph, StoryNode } from '../../api/client';

function node(id: string, ...lines: string[]): StoryNode {
  return {
    id,
    type: 'knot',
    parent: null,
    content: lines.map((text) => ({ text, tags: [] })),
    choices: [],
    divert: null,
    tags: [],
    lineNumber: 1,
  };
}

function graph(...nodes: StoryNode[]): StoryGraph {
  return {
    id: 'g1',
    title: 'Test story',
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    startNode: nodes[0]?.id ?? '',
    validation: { valid: true, errors: [], warnings: [] },
  };
}

const STORY = graph(
  node('intro', 'A cold morning at the docks.'),
  node('harbour', 'Gulls overhead.'),
  node('harbour_night'),
);

function renderPalette(over: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  const jumpToNode = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <CommandPalette open onClose={onClose} storyGraph={STORY} actions={{ jumpToNode }} {...over} />,
  );
  return { ...utils, jumpToNode, onClose };
}

const input = () => screen.getByRole('combobox');
const options = () => screen.getAllByRole('option');
const activeOption = () => screen.getByRole('option', { selected: true });

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { container } = renderPalette({ open: false });
    expect(container.firstChild).toBeNull();
  });

  it('lists every passage on open and focuses the input', () => {
    renderPalette();
    expect(options().map((o) => o.textContent)).toEqual([
      'introA cold morning at the docks.',
      'harbourGulls overhead.',
      'harbour_night',
    ]);
    expect(document.activeElement).toBe(input());
  });

  it('filters as you type, using the shared match rule', () => {
    renderPalette();
    // "gulls" is content, not an id — the shared rule matches both.
    fireEvent.change(input(), { target: { value: 'gulls' } });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent('harbour');
  });

  it('exposes the listbox to the input via aria-controls and activedescendant', () => {
    renderPalette();
    const listbox = screen.getByRole('listbox');
    expect(input()).toHaveAttribute('aria-controls', listbox.id);
    expect(input()).toHaveAttribute('aria-activedescendant', options()[0].id);
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
  });

  it('wraps each set of commands in a labelled ARIA group', () => {
    // A listbox's children have to be options or groups; a bare
    // heading row makes AT miscount "option N of M".
    renderPalette();
    const group = screen.getByRole('group', { name: 'Passages' });
    expect(within(group).getAllByRole('option')).toHaveLength(3);
  });

  it('moves the highlight with the arrow keys, wrapping at both ends', () => {
    renderPalette();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(activeOption()).toHaveTextContent('harbour');
    expect(input()).toHaveAttribute('aria-activedescendant', activeOption().id);

    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(activeOption()).toHaveTextContent('intro');

    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(activeOption()).toHaveTextContent('harbour_night');
  });

  it('leaves Home and End to the textbox caret', () => {
    // This combobox has an editable input; stealing Home/End would
    // strand the caret in the middle of a long passage name.
    renderPalette();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(fireEvent.keyDown(input(), { key: 'Home' })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: 'End' })).toBe(true);
    expect(activeOption()).toHaveTextContent('harbour');
  });

  it('keeps the arrow keys working after the list shrinks underneath it', () => {
    // A collaborator's save refetches the story while the palette is
    // open: the list gets shorter with no keystroke from this author.
    const three = ['a', 'b', 'c'];
    const provider = (ids: string[]) => () =>
      ids.map((id, i) => ({ id, group: 'Passages', label: id, rank: i, run: vi.fn() }));
    const { rerender } = renderPalette({ providers: [provider(three)] });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(activeOption()).toHaveTextContent('c');
    rerender(
      <CommandPalette
        open
        onClose={vi.fn()}
        storyGraph={STORY}
        actions={{ jumpToNode: vi.fn() }}
        providers={[provider(['a', 'b'])]}
      />,
    );
    expect(activeOption()).toHaveTextContent('b');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(activeOption()).toHaveTextContent('a');
  });

  it('runs the highlighted command on Enter and closes', () => {
    const { jumpToNode, onClose } = renderPalette();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(jumpToNode).toHaveBeenCalledWith('harbour');
    expect(onClose).toHaveBeenCalled();
  });

  it('runs a command on click', () => {
    const { jumpToNode } = renderPalette();
    fireEvent.mouseDown(options()[1]);
    expect(jumpToNode).toHaveBeenCalledWith('harbour');
  });

  it('keeps focus in the input when its own chrome is clicked', () => {
    // Otherwise the click blurs to <body>, and the arrow keys and the
    // Tab trap both stop working with the modal still on screen.
    renderPalette();
    expect(fireEvent.mouseDown(screen.getByTestId('command-palette'))).toBe(false);
    expect(fireEvent.mouseDown(options()[1])).toBe(false);
    // ...but the input itself still gets its caret.
    expect(fireEvent.mouseDown(input())).toBe(true);
  });

  it('leaves Enter and Escape to the IME while a candidate is composing', () => {
    const { jumpToNode, onClose } = renderPalette();
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input(), { key: 'Escape', isComposing: true });
    expect(jumpToNode).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores non-primary mouse buttons', () => {
    // A right-click is reaching for a context menu, not activating.
    const { jumpToNode, onClose } = renderPalette();
    fireEvent.mouseDown(options()[1], { button: 2 });
    fireEvent.mouseDown(screen.getByTestId('command-palette-backdrop'), { button: 2 });
    expect(jumpToNode).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to a given region when the invoker is gone on close', () => {
    // A jump that switches tabs unmounts the button that opened the
    // palette; without the fallback, focus lands on <body>.
    function Host() {
      const [open, setOpen] = useState(false);
      const [invokerGone, setInvokerGone] = useState(false);
      const fallback = useRef<HTMLElement>(null);
      return (
        <main ref={fallback} tabIndex={-1} data-testid="fallback">
          {!invokerGone && <button onClick={() => setOpen(true)}>Open</button>}
          <CommandPalette
            open={open}
            onClose={() => {
              setOpen(false);
              setInvokerGone(true);
            }}
            storyGraph={STORY}
            actions={{ jumpToNode: vi.fn() }}
            fallbackFocusRef={fallback}
          />
        </main>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('fallback'));
  });

  it('closes when the backdrop is clicked but not the dialog', () => {
    const { onClose } = renderPalette();
    fireEvent.mouseDown(screen.getByTestId('command-palette'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId('command-palette-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });

  it('announces the result count in a live region', () => {
    renderPalette();
    const status = screen.getByTestId('command-palette-status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('3 results');
    fireEvent.change(input(), { target: { value: 'gulls' } });
    expect(status).toHaveTextContent('1 result');
    fireEvent.change(input(), { target: { value: 'nothing here' } });
    expect(status).toHaveTextContent('No results');
  });

  it('says so when nothing matches, and Enter does nothing', () => {
    const { jumpToNode, onClose } = renderPalette();
    fireEvent.change(input(), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches.')).toBeInTheDocument();
    expect(input()).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(jumpToNode).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('resets the highlight when the query changes so Enter takes the top match', () => {
    const { jumpToNode } = renderPalette();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.change(input(), { target: { value: 'harbour' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(jumpToNode).toHaveBeenCalledWith('harbour');
  });

  it('is a modal dialog and traps Tab inside itself', () => {
    renderPalette();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The input is the only tab stop, so Tab in either direction has
    // to be swallowed and re-focused rather than escaping to the page
    // behind the modal. fireEvent returns false for a cancelled event.
    expect(fireEvent.keyDown(input(), { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(input());
  });

  it('returns focus to whatever opened it', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <CommandPalette
            open={open}
            onClose={() => setOpen(false)}
            storyGraph={STORY}
            actions={{ jumpToNode: vi.fn() }}
          />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });

  it('starts from a blank query each time it opens', () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen((v) => !v)}>Toggle</button>
          <CommandPalette
            open={open}
            onClose={() => setOpen(false)}
            storyGraph={STORY}
            actions={{ jumpToNode: vi.fn() }}
          />
        </>
      );
    }
    render(<Host />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'harbour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('caps a long list and says how much it is showing', () => {
    const many = graph(...Array.from({ length: 60 }, (_, i) => node(`n${i}`)));
    renderPalette({ storyGraph: many });
    expect(options()).toHaveLength(50);
    expect(screen.getByText(/Showing 50 of 60/)).toBeInTheDocument();
    expect(screen.getByTestId('command-palette-status')).toHaveTextContent(
      '60 results, showing the first 50',
    );
  });

  it('renders whatever providers it is given, not just passages', () => {
    const run = vi.fn();
    renderPalette({
      providers: [() => [{ id: 'c1', group: 'Flags', label: 'Jump to flag', rank: 0, run }]],
    });
    expect(options()).toHaveLength(1);
    expect(screen.getByText('Flags')).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(run).toHaveBeenCalled();
  });
});
