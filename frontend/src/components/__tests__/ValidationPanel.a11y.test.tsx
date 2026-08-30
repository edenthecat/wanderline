// Validation runs after every edit and used to report only by
// re-rendering a plain <section>. An author using a screen reader
// could introduce a syntax error and be told nothing — and if they
// found the panel, "your story will not build" and "this knot is
// unreachable" were told apart by a border colour.

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ValidationPanel from '../ValidationPanel';
import type { ValidationMessage } from '../../api/client';
import { expectNoAxeViolations } from '../../test-a11y';

const err = (over: Partial<ValidationMessage> = {}): ValidationMessage =>
  ({
    type: 'syntax_error',
    message: 'Unclosed [ on line 4',
    lineNumber: 4,
    ...over,
  }) as ValidationMessage;

const warn = (over: Partial<ValidationMessage> = {}): ValidationMessage =>
  ({
    type: 'unreachable_node',
    message: 'Nothing reaches `attic`',
    nodeId: 'attic',
    ...over,
  }) as ValidationMessage;

const liveText = () => screen.getByTestId('validation-status').textContent;

describe('ValidationPanel accessibility', () => {
  it('keeps a live region mounted even with nothing to report', () => {
    render(<ValidationPanel errors={[]} warnings={[]} />);
    const region = screen.getByTestId('validation-status');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // Nothing to announce on arrival — the state you walked in on
    // isn't news.
    expect(region.textContent).toBe('');
    expect(screen.queryByTestId('validation-panel')).toBeNull();
  });

  it('announces problems appearing after an edit', async () => {
    const { rerender } = render(<ValidationPanel errors={[]} warnings={[]} />);
    expect(liveText()).toBe('');
    rerender(<ValidationPanel errors={[err()]} warnings={[warn()]} />);
    await waitFor(() =>
      expect(liveText()).toBe('1 error, 1 warning in your story. Unclosed [ on line 4'),
    );
  });

  it('announces the last problem clearing, after the panel is gone', async () => {
    const { rerender } = render(<ValidationPanel errors={[err()]} warnings={[]} />);
    rerender(<ValidationPanel errors={[err(), err()]} warnings={[]} />);
    await waitFor(() => expect(liveText()).toContain('2 errors in your story.'));

    rerender(<ValidationPanel errors={[]} warnings={[]} />);
    // The panel unmounts; the region does not, which is the only
    // reason this can be said at all.
    expect(screen.queryByTestId('validation-panel')).toBeNull();
    await waitFor(() => expect(liveText()).toBe('No problems in your story.'));
  });

  it('speaks up when one problem is swapped for another at the same count', async () => {
    // Fixing the unclosed `[` in the same edit that introduces a bad
    // divert leaves "1 error" reading identically. Announcing on the
    // count alone would tell the author their fix landed.
    const { rerender } = render(<ValidationPanel errors={[]} warnings={[]} />);
    rerender(<ValidationPanel errors={[err()]} warnings={[]} />);
    await waitFor(() => expect(liveText()).toContain('Unclosed ['));

    rerender(
      <ValidationPanel
        errors={[err({ message: 'Unknown divert target `celler` on line 9', lineNumber: 9 })]}
        warnings={[]}
      />,
    );
    await waitFor(() => expect(liveText()).toContain('celler'));
    expect(liveText()).toContain('1 error in your story.');
  });

  it('spells out severity instead of leaving it to the glyph', () => {
    render(<ValidationPanel errors={[err()]} warnings={[warn()]} />);
    expect(screen.getByText('Error:')).toBeInTheDocument();
    expect(screen.getByText('Warning:')).toBeInTheDocument();
    // The glyph itself stays decorative.
    const glyphs = document.querySelectorAll('.validation-icon');
    expect(glyphs).toHaveLength(2);
    glyphs.forEach((g) => expect(g).toHaveAttribute('aria-hidden', 'true'));
  });

  it('separates errors from warnings into their own headed lists', () => {
    render(<ValidationPanel errors={[err()]} warnings={[warn()]} />);
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual([
      'Errors — these stop the build',
      'Warnings — the story still builds',
    ]);
    expect(screen.getAllByRole('list')).toHaveLength(2);
  });

  it('shows only the heading for the severity present', () => {
    render(<ValidationPanel errors={[]} warnings={[warn()]} />);
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toContain('Warnings');
  });

  it('leaves the toggle a plain sentence, not a triangle', () => {
    render(<ValidationPanel errors={[err()]} warnings={[]} />);
    const toggle = screen.getByRole('button', { expanded: true });
    // The name used to open "black down-pointing triangle".
    expect(toggle).toHaveAccessibleName(/^1 error\s*in your story$/);
  });

  it('has no axe violations', async () => {
    const { container } = render(<ValidationPanel errors={[err()]} warnings={[warn()]} />);
    await expectNoAxeViolations(container);
  });
});
