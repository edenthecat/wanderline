import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SystemSoundsTab from '../SystemSoundsTab';

// The editor half of per-choice indicator sounds.
//
// The backend and the player have honoured
// settings.choiceIndicatorAudio.{choice1FileId,choice2FileId} for a
// while, but nothing in the editor ever wrote them, so authors asking
// for "different sounds for choice 1 and choice 2" had no way to set
// one. These cover the controls existing and, more importantly, that
// changing one side sends only that side.

vi.mock('../../api/client', () => ({
  fetchProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  fetchAudioFiles: vi.fn(),
}));

const { fetchProjectSettings, updateProjectSettings, fetchAudioFiles } =
  await import('../../api/client');
const mockedFetchSettings = vi.mocked(fetchProjectSettings);
const mockedUpdate = vi.mocked(updateProjectSettings);
const mockedAudio = vi.mocked(fetchAudioFiles);

const AUDIO = [
  { id: 'beep-1', original_name: 'beep-one.mp3', category: 'indicator' },
  { id: 'beep-2', original_name: 'beep-two.mp3', category: 'indicator' },
  { id: 'vo-1', original_name: 'narration.mp3', category: 'voiceover' },
];

function mount(settings: Record<string, unknown> = {}) {
  mockedFetchSettings.mockResolvedValue({ settings } as never);
  mockedUpdate.mockResolvedValue({ settings } as never);
  mockedAudio.mockResolvedValue({ audioFiles: AUDIO } as never);
  return render(<SystemSoundsTab projectId="p1" />);
}

beforeEach(() => {
  mockedFetchSettings.mockReset();
  mockedUpdate.mockReset();
  mockedAudio.mockReset();
});

afterEach(() => cleanup());

describe('per-choice indicator controls', () => {
  it('offers a sound picker for each choice', async () => {
    mount();
    expect(await screen.findByLabelText('Choice 1 sound')).toBeInTheDocument();
    expect(await screen.findByLabelText('Choice 2 sound')).toBeInTheDocument();
  });

  it('only lists indicator-category audio, not voiceover', async () => {
    mount();
    const select = await screen.findByLabelText('Choice 1 sound');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('beep-one.mp3');
    expect(options).not.toContain('narration.mp3');
  });

  it('reflects what the project already has stored', async () => {
    mount({ choiceIndicatorAudio: { choice1FileId: 'beep-1', choice2FileId: 'beep-2' } });
    await waitFor(() =>
      expect((screen.getByLabelText('Choice 1 sound') as HTMLSelectElement).value).toBe('beep-1'),
    );
    expect((screen.getByLabelText('Choice 2 sound') as HTMLSelectElement).value).toBe('beep-2');
  });

  it('defaults to "same as default" when nothing is set', async () => {
    mount();
    const select = (await screen.findByLabelText('Choice 1 sound')) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.querySelector('option')?.textContent).toBe('(same as default)');
  });

  // The important one. The endpoint merges this key nested, so sending
  // only the changed side is what stops choice 2 being wiped whenever
  // choice 1 is edited.
  it('sends only the side that changed', async () => {
    mount({ choiceIndicatorAudio: { choice1FileId: 'beep-1', choice2FileId: 'beep-2' } });
    const select = await screen.findByLabelText('Choice 2 sound');
    fireEvent.change(select, { target: { value: 'beep-1' } });

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    const [, patch] = mockedUpdate.mock.calls[0];
    expect(patch).toEqual({ choiceIndicatorAudio: { choice2FileId: 'beep-1' } });
    expect((patch as Record<string, never>).choiceIndicatorAudio).not.toHaveProperty(
      'choice1FileId',
    );
  });

  it('sends null when the author picks "same as default"', async () => {
    mount({ choiceIndicatorAudio: { choice1FileId: 'beep-1' } });
    const select = await screen.findByLabelText('Choice 1 sound');
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    const [, patch] = mockedUpdate.mock.calls[0];
    expect(patch).toEqual({ choiceIndicatorAudio: { choice1FileId: null } });
  });

  it('leaves the separate default-indicator control working', async () => {
    mount();
    const select = await screen.findByLabelText('Default indicator sound');
    fireEvent.change(select, { target: { value: 'beep-2' } });

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    const [, patch] = mockedUpdate.mock.calls[0];
    expect(patch).toEqual({ defaultIndicatorAudioId: 'beep-2' });
  });
});
