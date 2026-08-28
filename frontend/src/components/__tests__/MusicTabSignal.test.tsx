import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// The music library is half of the in-context mix: the node panel lays
// the first track under every passage it auditions. A track added or
// removed here has to reach a Story tab that is already open, or that
// panel goes on mixing with a file that is gone — and asking the server
// for it.

vi.mock('../../api/client', () => ({
  fetchAudioFiles: vi.fn(),
  uploadAudioFile: vi.fn(),
  deleteAudioFile: vi.fn(),
  audioFileUrl: (projectId: string, id: string) => `/audio/${projectId}/${id}`,
}));

const doc = new Y.Doc();
vi.mock('../../hooks/useYjs', () => ({
  useYjs: () => ({ doc, awareness: null, status: 'connected' as const }),
}));

const client = await import('../../api/client');
const { default: MusicTab } = await import('../MusicTab');

const AUDIO_ASSIGNMENTS_SIGNAL = 'audio-assignments';
const signalTick = () => doc.getMap<number>('__signals__').get(AUDIO_ASSIGNMENTS_SIGNAL);

const track = (id: string, name: string) =>
  ({ id, original_name: name, category: 'music', size_bytes: 1 }) as unknown as Awaited<
    ReturnType<typeof client.fetchAudioFiles>
  >['audioFiles'][number];

beforeEach(() => {
  doc.getMap<number>('__signals__').delete(AUDIO_ASSIGNMENTS_SIGNAL);
  vi.mocked(client.fetchAudioFiles).mockResolvedValue({ audioFiles: [] });
  vi.mocked(client.uploadAudioFile).mockResolvedValue({
    audioFile: track('m1', 'dusk.mp3'),
  });
  vi.mocked(client.deleteAudioFile).mockResolvedValue({ success: true });
});

describe('MusicTab — telling other tabs the library moved', () => {
  it('signals after an upload', async () => {
    render(<MusicTab projectId="p1" />);
    await waitFor(() => expect(client.fetchAudioFiles).toHaveBeenCalled());

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Upload music'), {
        target: { files: [new File(['x'], 'dusk.mp3', { type: 'audio/mpeg' })] },
      });
    });

    await waitFor(() => expect(typeof signalTick()).toBe('number'));
  });

  it('signals after a delete', async () => {
    vi.mocked(client.fetchAudioFiles).mockResolvedValue({
      audioFiles: [track('m1', 'dusk.mp3')],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MusicTab projectId="p1" />);
    await screen.findByText('dusk.mp3');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove/i }));
    });

    await waitFor(() => expect(typeof signalTick()).toBe('number'));
  });

  it('stays quiet when the upload fails — nothing changed to tell about', async () => {
    vi.mocked(client.uploadAudioFile).mockRejectedValue(new Error('offline'));
    render(<MusicTab projectId="p1" />);
    await waitFor(() => expect(client.fetchAudioFiles).toHaveBeenCalled());

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Upload music'), {
        target: { files: [new File(['x'], 'dusk.mp3', { type: 'audio/mpeg' })] },
      });
    });

    expect(signalTick()).toBeUndefined();
  });
});
