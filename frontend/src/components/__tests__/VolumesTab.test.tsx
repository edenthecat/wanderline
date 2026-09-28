import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VolumesTab from '../VolumesTab';

// The player now plays per-passage ambience and sound effects at their
// own level, so the author needs a default for it next to the others.

vi.mock('../../api/client', () => ({
  fetchProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
}));

const { fetchProjectSettings, updateProjectSettings } = await import('../../api/client');
const mockedFetch = vi.mocked(fetchProjectSettings);
const mockedUpdate = vi.mocked(updateProjectSettings);

beforeEach(() => {
  mockedFetch.mockReset();
  mockedUpdate.mockReset();
});

afterEach(() => cleanup());

describe('VolumesTab ambience default', () => {
  it('shows the player’s own default when the author hasn’t set one', async () => {
    mockedFetch.mockResolvedValue({ settings: {} } as never);
    render(<VolumesTab projectId="p1" />);
    const slider = await screen.findByLabelText('Ambience & sound effects default volume');
    expect((slider as HTMLInputElement).value).toBe('50');
  });

  it('saves a change as ambienceVolume', async () => {
    mockedFetch.mockResolvedValue({ settings: { ambienceVolume: 40 } } as never);
    mockedUpdate.mockResolvedValue({ settings: { ambienceVolume: 70 } } as never);
    render(<VolumesTab projectId="p1" />);
    const slider = await screen.findByLabelText('Ambience & sound effects default volume');
    expect((slider as HTMLInputElement).value).toBe('40');
    fireEvent.change(slider, { target: { value: '70' } });
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith('p1', { ambienceVolume: 70 }), {
      timeout: 3000,
    });
  });
});
