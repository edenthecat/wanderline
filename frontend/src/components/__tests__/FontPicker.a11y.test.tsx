// Font choice is an accessibility decision an author makes on behalf
// of their listeners, and this is the control for it. It was a text
// input with `aria-expanded` and no `role`, driving a highlight that
// existed only as a background colour.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FontPicker from '../FontPicker';
import { GOOGLE_FONTS } from '../../api/google-fonts';
import { expectNoAxeViolations } from '../../test-a11y';

function open(value = '') {
  const onChange = vi.fn();
  const utils = render(<FontPicker value={value} onChange={onChange} ariaLabel="Body font" />);
  const input = screen.getByLabelText('Body font');
  fireEvent.focus(input);
  return { ...utils, input, onChange };
}

const activeOption = (input: HTMLElement) => {
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};

describe('FontPicker accessibility', () => {
  it('declares itself a combobox over the listbox it controls', () => {
    const { input } = open();
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    // aria-controls has to actually land on the listbox, or the
    // relationship is decorative.
    const listbox = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
  });

  it('points aria-activedescendant at the row the arrow keys moved to', () => {
    const { input } = open();
    expect(activeOption(input)).toHaveTextContent(GOOGLE_FONTS[0].family);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toHaveTextContent(GOOGLE_FONTS[1].family);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption(input)).toHaveTextContent(GOOGLE_FONTS[1].family);
  });

  it('marks the arrowed-to row as the selected option', () => {
    const { input } = open();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('names the committed value in text, not by background colour alone', () => {
    open('Roboto');
    const options = screen.getAllByRole('option');
    const roboto = options.find((o) => o.textContent?.startsWith('Roboto ('));
    expect(roboto?.textContent).toContain('(current font)');
    // and nothing else claims to be the current font
    expect(options.filter((o) => o.textContent?.includes('(current font)'))).toHaveLength(1);
  });

  it('scrolls the highlighted row into view as it moves past the fold', () => {
    // The dropdown is maxHeight: 280 — roughly eight rows. jsdom has no
    // scrollIntoView, so stub it and assert we ask for it.
    const scrollIntoView = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).scrollIntoView = scrollIntoView;
    try {
      const { input } = open();
      scrollIntoView.mockClear();
      for (let i = 0; i < 10; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(scrollIntoView).toHaveBeenCalled();
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (Element.prototype as any).scrollIntoView;
    }
  });

  it('never points aria-activedescendant at a row that is not rendered', () => {
    const { input } = open();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Filtering down to a single match invalidates the old index.
    fireEvent.change(input, { target: { value: 'Roboto Slab' } });
    const id = input.getAttribute('aria-activedescendant');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).not.toBeNull();
  });

  it('distinguishes highlighted from selected by more than colour', () => {
    const { input } = open('Roboto');
    // Roboto is index 1; leave the highlight on index 0 so the two
    // states are on different rows.
    const [highlighted, selected] = screen.getAllByRole('option');
    expect(highlighted.style.borderLeftColor).not.toBe('transparent');
    expect(selected.style.borderLeftColor).toBe('transparent');
    expect(highlighted.style.fontWeight).toBe('600');
    expect(selected.style.fontWeight).toBe('400');
    expect(input).toBeInTheDocument();
  });

  it('has no axe violations, open or closed', async () => {
    const { container, input } = open('Roboto');
    await expectNoAxeViolations(container);
    fireEvent.keyDown(input, { key: 'Tab' });
    await expectNoAxeViolations(container);
  });
});
