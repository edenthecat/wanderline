import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PlayerDisplayTab from '../PlayerDisplayTab';

// Auto-advance is the one option here that stays OFF unless asked for,
// so it can't be read with the `!== false` the display toggles use.
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
  it('is offered as a setting', async () => {
    mockSettings = {};
    render(<PlayerDisplayTab projectId="p1" />);
    expect(await screen.findByText('Advance automatically')).toBeTruthy();
  });

  it('is unchecked when the project has never set it', async () => {
    mockSettings = {};
    render(<PlayerDisplayTab projectId="p1" />);
    const box = (await screen.findByText('Advance automatically'))
      .closest('label')
      ?.querySelector('input') as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it('is checked once the author turns it on', async () => {
    mockSettings = { autoAdvance: true };
    render(<PlayerDisplayTab projectId="p1" />);
    const box = (await screen.findByText('Advance automatically'))
      .closest('label')
      ?.querySelector('input') as HTMLInputElement;
    expect(box.checked).toBe(true);
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
