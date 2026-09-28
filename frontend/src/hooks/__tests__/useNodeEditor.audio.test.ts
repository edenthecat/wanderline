import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The node panel's audio actions. Replacing has to go through the atomic
// reassign endpoint, which keeps a sound effect's timing; assign would
// drop it. Every change refetches so the panel shows the result.

vi.mock('../../api/client', () => {
  const ok = () => vi.fn().mockResolvedValue({});
  return {
    addChoice: ok(),
    deleteChoice: ok(),
    fetchCharacters: vi.fn().mockResolvedValue({ characters: [] }),
    fetchNodeFlags: vi.fn().mockResolvedValue({ flags: [], truncated: false }),
    fetchMetadata: vi.fn().mockResolvedValue({ metadata: {} }),
    renameNode: ok(),
    swapChoices: ok(),
    updateChoiceTarget: ok(),
    updateChoiceText: ok(),
    updateDivert: ok(),
    updateNodeContentText: ok(),
    updateNodeMetadata: ok(),
    fetchAudioAssignments: vi.fn().mockResolvedValue({ assignments: {}, raw: [] }),
    fetchAudioFiles: vi.fn().mockResolvedValue({ audioFiles: [] }),
    fetchProjectSettings: vi.fn().mockResolvedValue({ settings: {} }),
    assignAudio: ok(),
    bulkReassignAudio: vi.fn().mockResolvedValue({ success: true, swapped: 1 }),
    removeAudioAssignment: ok(),
    setSfxOffset: ok(),
  };
});

const client = await import('../../api/client');
const { useNodeEditor } = await import('../useNodeEditor');

function mount() {
  return renderHook(() =>
    useNodeEditor({ projectId: 'p1', storyGraph: null, onStoryUpdated: () => undefined }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useNodeEditor audio actions', () => {
  it('loads the library for the pickers', async () => {
    vi.mocked(client.fetchAudioFiles).mockResolvedValue({
      audioFiles: [{ id: 'rain', original_name: 'rain.mp3' }],
    } as never);
    const { result } = mount();
    await waitFor(() => expect(result.current.audioFiles).toHaveLength(1));
  });

  it('replaces through the reassign endpoint so a sound effect keeps its timing', async () => {
    const { result } = mount();
    await act(() => result.current.audioActions.replace('hall', 'sfx', 'door', 'bell'));
    expect(client.bulkReassignAudio).toHaveBeenCalledWith('p1', [
      { nodeId: 'hall', audioType: 'sfx', fromFileId: 'door', toFileId: 'bell' },
    ]);
    expect(client.assignAudio).not.toHaveBeenCalled();
  });

  // A peer may have swapped the slot since this panel last refetched;
  // naming the file keeps a clear from removing their new take.
  it('clears only the file the author saw', async () => {
    const { result } = mount();
    await act(() => result.current.audioActions.clear('hall', 'ambience', 'rain'));
    expect(client.removeAudioAssignment).toHaveBeenLastCalledWith('p1', 'hall', 'ambience', 'rain');
    await act(() => result.current.audioActions.clear('hall', 'sfx', 'door'));
    expect(client.removeAudioAssignment).toHaveBeenLastCalledWith('p1', 'hall', 'sfx', 'door');
  });

  it('loads the project’s levels for the mix audition', async () => {
    vi.mocked(client.fetchProjectSettings).mockResolvedValue({
      settings: { voiceoverVolume: 70, ambienceVolume: 35 },
    } as never);
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.audioLevels).toEqual({ voiceover: 70, ambience: 35 }),
    );
  });

  it('refetches after a change', async () => {
    const { result } = mount();
    await waitFor(() => expect(client.fetchAudioAssignments).toHaveBeenCalledTimes(1));
    await act(() => result.current.audioActions.setSfxOffset('hall', 'door', 1200));
    expect(client.setSfxOffset).toHaveBeenCalledWith('p1', 'hall', 'door', 1200);
    await waitFor(() => expect(client.fetchAudioAssignments).toHaveBeenCalledTimes(2));
  });

  // The usual cause of a failure is a peer having changed the slot, so
  // the panel refetches to show what's there now.
  it('lets a failure reach the panel, and still refetches', async () => {
    vi.mocked(client.assignAudio).mockRejectedValueOnce(new Error('nope'));
    const { result } = mount();
    await waitFor(() => expect(client.fetchAudioAssignments).toHaveBeenCalledTimes(1));
    await act(async () => {
      await expect(result.current.audioActions.assign('hall', 'voiceover', 'vo1')).rejects.toThrow(
        'nope',
      );
    });
    await waitFor(() => expect(client.fetchAudioAssignments).toHaveBeenCalledTimes(2));
  });

  it('loads levels once per project, not on every change', async () => {
    const { result } = mount();
    await waitFor(() => expect(client.fetchProjectSettings).toHaveBeenCalledTimes(1));
    await act(() => result.current.audioActions.setSfxOffset('hall', 'door', 500));
    await waitFor(() => expect(client.fetchAudioAssignments).toHaveBeenCalledTimes(2));
    expect(client.fetchProjectSettings).toHaveBeenCalledTimes(1);
  });
});
