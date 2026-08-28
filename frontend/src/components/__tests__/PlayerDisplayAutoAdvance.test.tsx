import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PlayerDisplayTab from '../PlayerDisplayTab';

// Auto-advance is the one option here that stays OFF unless asked for,
// so it can't be read with the `!== false` the display toggles use.
//
// It is also the only one that isn't the final word: it sets where each
// listener's own toggle starts, which is why the label says "(default)".
// Matched on a prefix so wording can move without breaking these.
const updateOne = vi.fn();
let mockSettings: Record<string, unknown> = {};

vi.mock('../../hooks/useProjectSettings', () => ({
  useProjectSettings: () => ({
    settings: mockSettings,
    loading: false,
    error: null,
    updateOne,
  }),
}));

describe('PlayerDisplayTab — auto-advance', () => {
  it('is offered as a setting, named as a default', async () => {
    mockSettings = {};
    render(<PlayerDisplayTab projectId="p1" />);
    expect(await screen.findByText(/^Advance automatically/)).toBeTruthy();
  });

  it('is unchecked when the project has never set it', async () => {
    mockSettings = {};
    render(<PlayerDisplayTab projectId="p1" />);
    const box = (await screen.findByText(/^Advance automatically/))
      .closest('label')
      ?.querySelector('input') as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it('is checked once the author turns it on', async () => {
    mockSettings = { autoAdvance: true };
    render(<PlayerDisplayTab projectId="p1" />);
    const box = (await screen.findByText(/^Advance automatically/))
      .closest('label')
      ?.querySelector('input') as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('says the listener can change it', async () => {
    mockSettings = {};
    render(<PlayerDisplayTab projectId="p1" />);
    const hint = (await screen.findByText(/^Advance automatically/)).closest('label')?.textContent;
    expect(hint).toMatch(/listener/i);
  });

  // Display options keep their old default-on behaviour.
  it('leaves the display toggles defaulting on', async () => {
    mockSettings = {};
    render(<PlayerDisplayTab projectId="p1" />);
    await waitFor(() => expect(screen.getByText('Show progress bar')).toBeTruthy());
    const box = screen
      .getByText('Show progress bar')
      .closest('label')
      ?.querySelector('input') as HTMLInputElement;
    expect(box.checked).toBe(true);
  });
});
