import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The project half of the in-context mix: the author's volumes and the
// track a listener would have playing underneath this passage.
//
// The "hide it rather than guess" rule is the load-bearing one. A mix
// assembled from defaults after a failed settings fetch would look
// authoritative and be wrong — which is precisely the failure mode
// (volumes silently not what the author set) the control exists to
// catch, reintroduced by the control itself.

vi.mock('../../api/client', () => ({
  fetchAudioAssignments: vi.fn(),
  fetchAudioFiles: vi.fn(),
  fetchCharacters: vi.fn(),
  fetchNodeFlags: vi.fn(),
  fetchMetadata: vi.fn(),
  fetchProjectSettings: vi.fn(),
  addChoice: vi.fn(),
  deleteChoice: vi.fn(),
  renameNode: vi.fn(),
  swapChoices: vi.fn(),
  updateChoiceTarget: vi.fn(),
  updateChoiceText: vi.fn(),
  updateDivert: vi.fn(),
  updateNodeContentText: vi.fn(),
  updateNodeMetadata: vi.fn(),
}));

const client = await import('../../api/client');
const { useNodeEditor } = await import('../useNodeEditor');

const audioFile = (id: string, original_name: string, category: string) =>
  ({ id, original_name, category }) as unknown as Awaited<
    ReturnType<typeof client.fetchAudioFiles>
  >['audioFiles'][number];

function mountEditor() {
  return renderHook(() =>
    useNodeEditor({ projectId: 'p1', storyGraph: null, onStoryUpdated: vi.fn() }),
  );
}

beforeEach(() => {
  vi.mocked(client.fetchAudioAssignments).mockResolvedValue({ assignments: {}, raw: [] });
  vi.mocked(client.fetchCharacters).mockResolvedValue({ characters: [] });
  vi.mocked(client.fetchNodeFlags).mockResolvedValue({ flags: [], truncated: false });
  vi.mocked(client.fetchMetadata).mockResolvedValue({ metadata: {} });
  vi.mocked(client.fetchProjectSettings).mockResolvedValue({ settings: {} });
  vi.mocked(client.fetchAudioFiles).mockResolvedValue({ audioFiles: [] });
});

describe('useNodeEditor — mix context', () => {
  it("resolves the author's volumes without a listener's per-device override", async () => {
    vi.mocked(client.fetchProjectSettings).mockResolvedValue({
      settings: { voiceoverVolume: 60, backgroundMusicVolume: 25 },
    });
    const { result } = mountEditor();

    await waitFor(() => expect(result.current.mixContext).not.toBeNull());
    expect(result.current.mixContext!.volumes).toEqual({
      voiceover: 60,
      backgroundMusic: 25,
      indicator: 50,
    });
  });

  // Alphabetical by uploaded name, matching the build pipeline's sort;
  // the player starts that playlist at index 0.
  it('picks the music track the player would start with', async () => {
    vi.mocked(client.fetchAudioFiles).mockResolvedValue({
      audioFiles: [
        audioFile('m2', 'zither.mp3', 'music'),
        audioFile('vo', 'aaa-her.mp3', 'voiceover'),
        audioFile('m1', 'dusk.mp3', 'music'),
      ],
    });
    const { result } = mountEditor();

    await waitFor(() => expect(result.current.mixContext).not.toBeNull());
    expect(result.current.mixContext!.backgroundMusic).toEqual({
      fileId: 'm1',
      name: 'dusk.mp3',
    });
  });

  it('reports no music when the project has none', async () => {
    const { result } = mountEditor();
    await waitFor(() => expect(result.current.mixContext).not.toBeNull());
    expect(result.current.mixContext!.backgroundMusic).toBeNull();
  });

  it.each([['fetchProjectSettings'], ['fetchAudioFiles']] as const)(
    'offers no mix at all when %s fails, rather than a plausible wrong one',
    async (failing) => {
      vi.mocked(client.fetchProjectSettings).mockResolvedValue({
        settings: { backgroundMusicVolume: 25 },
      });
      vi.mocked(
        failing === 'fetchProjectSettings' ? client.fetchProjectSettings : client.fetchAudioFiles,
      ).mockRejectedValue(new Error('offline'));
      const { result } = mountEditor();

      // Wait on the lookups actually settling rather than on nothing
      // happening, so a mix that arrives late would still be caught.
      await waitFor(() => expect(client.fetchAudioFiles).toHaveBeenCalledWith('p1'));
      await act(async () => {});
      expect(result.current.mixContext).toBeNull();
    },
  );
});
