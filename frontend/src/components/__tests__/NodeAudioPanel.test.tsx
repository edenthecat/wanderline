import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NodeAudioPanel, { formatOffsetSeconds, parseOffsetSeconds } from '../NodeAudioPanel';
import type { AudioFile } from '../../api/client';
import type { NodeAudioActions } from '../../hooks/useNodeEditor';

// The node panel's audio section. It used to be play-only: attaching or
// swapping a clip meant a trip to the Audio tab, and ambience/effects
// couldn't be heard together anywhere.

vi.mock('../../api/client', () => ({
  audioFileUrl: (projectId: string, id: string) => `/api/${projectId}/audio/${id}`,
}));

class FakeAudio {
  static made: FakeAudio[] = [];
  loop = false;
  muted = false;
  currentTime = 0;
  volume = 1;
  paused = true;
  preload = '';
  src: string;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  constructor(src = '') {
    this.src = src;
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

const file = (id: string, category: string): AudioFile =>
  ({ id, original_name: `${id}.mp3`, category }) as AudioFile;

// Order of the empty-slot rows once "Attach audio…" is open.
const SLOT_INDEX = { voiceover: 0, ambience: 1, choice1: 2, choice2: 3 } as const;

const FILES = [
  file('vo1', 'voiceover'),
  file('vo2', 'voiceover'),
  file('rain', 'ambience'),
  file('wind', 'ambience'),
  file('door', 'sfx'),
  file('bell', 'sfx'),
];

function actions(): NodeAudioActions & { [k: string]: ReturnType<typeof vi.fn> } {
  return {
    assign: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    setSfxOffset: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function mount(nodeAudio: Parameters<typeof NodeAudioPanel>[0]['nodeAudio'], a = actions()) {
  render(
    <NodeAudioPanel
      projectId="p1"
      nodeId="hall"
      nodeAudio={nodeAudio}
      audioFiles={FILES}
      actions={a}
    />,
  );
  return a;
}

beforeEach(() => {
  FakeAudio.made = [];
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('offset text', () => {
  it('reads seconds as the author types them', () => {
    expect(parseOffsetSeconds('')).toBeNull();
    expect(parseOffsetSeconds(' 2.5 ')).toBe(2500);
    expect(parseOffsetSeconds('0')).toBe(0);
    expect(parseOffsetSeconds('1.2345')).toBe(1235);
    expect(parseOffsetSeconds('-1')).toBe('invalid');
    expect(parseOffsetSeconds('2s')).toBe('invalid');
    expect(parseOffsetSeconds('4000')).toBe('invalid');
  });

  it('shows stored milliseconds as seconds', () => {
    expect(formatOffsetSeconds(undefined)).toBe('');
    expect(formatOffsetSeconds(2500)).toBe('2.5');
    expect(formatOffsetSeconds(1235)).toBe('1.235');
  });
});

/** Pick a file in an open picker and confirm it. */
function choose(pickerLabel: string, fileId: string, confirm: string) {
  fireEvent.change(screen.getByLabelText(pickerLabel), { target: { value: fileId } });
  fireEvent.click(screen.getByRole('button', { name: confirm }));
}

describe('NodeAudioPanel', () => {
  it('keeps empty slots out of the way until asked', () => {
    mount({ sfx: [] });
    expect(screen.queryByLabelText('Ambience to attach to hall')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    expect(screen.getByLabelText('Ambience to attach to hall')).toBeTruthy();
  });

  it('attaches a file to an empty slot', async () => {
    const a = mount({ sfx: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    fireEvent.change(screen.getByLabelText('Ambience to attach to hall'), {
      target: { value: 'rain' },
    });
    const attach = screen.getAllByRole('button', { name: 'Attach' });
    fireEvent.click(attach[SLOT_INDEX.ambience]);
    await waitFor(() => expect(a.assign).toHaveBeenCalledWith('hall', 'ambience', 'rain'));
  });

  // Arrowing through a closed <select> changes its value on Windows and
  // Linux; that alone must never swap a take.
  it('does nothing until the choice is confirmed', () => {
    const a = mount({ voiceover: 'vo1', sfx: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.change(screen.getByLabelText('Replacement voiceover for hall'), {
      target: { value: 'vo2' },
    });
    expect(a.replace).not.toHaveBeenCalled();
  });

  it('offers the slot’s own category first, then everything else', () => {
    mount({ sfx: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    const select = screen.getByLabelText('Ambience to attach to hall') as HTMLSelectElement;
    const groups = [...select.querySelectorAll('optgroup')];
    expect(groups.map((g) => g.label)).toEqual(['Ambience files', 'Other files']);
    const first = [...groups[0].querySelectorAll('option')].map((o) => o.value);
    expect(first).toEqual(['rain', 'wind']);
  });

  it('swaps an attached file for another', async () => {
    const a = mount({ voiceover: 'vo1', sfx: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    const select = screen.getByLabelText('Replacement voiceover for hall') as HTMLSelectElement;
    // The current file isn't offered as its own replacement.
    expect([...select.options].map((o) => o.value)).not.toContain('vo1');
    choose('Replacement voiceover for hall', 'vo2', 'Use');
    await waitFor(() => expect(a.replace).toHaveBeenCalledWith('hall', 'voiceover', 'vo1', 'vo2'));
  });

  it('clears a slot', async () => {
    const a = mount({ ambience: 'rain', sfx: [] });
    fireEvent.click(screen.getByLabelText('Remove ambience from hall'));
    await waitFor(() => expect(a.clear).toHaveBeenCalledWith('hall', 'ambience', 'rain'));
  });

  it('adds, replaces and removes sound effects', async () => {
    const a = mount({ sfx: ['door'] });
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    const add = screen.getByLabelText('Sound effect to add to hall') as HTMLSelectElement;
    // Already-attached effects can't be added twice.
    expect([...add.options].map((o) => o.value)).not.toContain('door');
    choose('Sound effect to add to hall', 'bell', 'Add');
    await waitFor(() => expect(a.assign).toHaveBeenCalledWith('hall', 'sfx', 'bell'));

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    choose('Replacement for SFX 1 on hall', 'bell', 'Use');
    await waitFor(() => expect(a.replace).toHaveBeenCalledWith('hall', 'sfx', 'door', 'bell'));

    fireEvent.click(screen.getByLabelText('Remove SFX 1 from hall'));
    await waitFor(() => expect(a.clear).toHaveBeenCalledWith('hall', 'sfx', 'door'));
  });

  it('times a sound effect in seconds and clears it back to the start', async () => {
    const a = mount({ sfx: ['door'], sfxOffsets: { door: 1500 } });
    const input = screen.getByLabelText('When SFX 1 plays, in seconds') as HTMLInputElement;
    expect(input.value).toBe('1.5');

    fireEvent.change(input, { target: { value: '2.25' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalledWith('hall', 'door', 2250));

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenLastCalledWith('hall', 'door', null));
  });

  it('keeps the timing field (and its focus) when the saved value comes back', async () => {
    const a = actions();
    const { rerender } = render(
      <NodeAudioPanel
        projectId="p1"
        nodeId="hall"
        nodeAudio={{ sfx: ['door'], sfxOffsets: { door: 1500 } }}
        audioFiles={FILES}
        actions={a}
      />,
    );
    const input = screen.getByLabelText('When SFX 1 plays, in seconds') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalled());
    rerender(
      <NodeAudioPanel
        projectId="p1"
        nodeId="hall"
        nodeAudio={{ sfx: ['door'], sfxOffsets: { door: 3000 } }}
        audioFiles={FILES}
        actions={a}
      />,
    );
    const after = screen.getByLabelText('When SFX 1 plays, in seconds') as HTMLInputElement;
    expect(after).toBe(input);
    expect(after.value).toBe('3');
    expect(document.activeElement).toBe(input);
  });

  // Tabbing from one effect's field to the next must save both, even
  // though the first save is still in flight.
  it('saves a second timing while the first is still saving', async () => {
    const a = actions();
    let release!: () => void;
    a.setSfxOffset.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    mount({ sfx: ['door', 'bell'] }, a);
    const first = screen.getByLabelText('When SFX 1 plays, in seconds');
    const second = screen.getByLabelText('When SFX 2 plays, in seconds');
    fireEvent.change(first, { target: { value: '1' } });
    fireEvent.blur(first);
    fireEvent.change(second, { target: { value: '2' } });
    fireEvent.blur(second);
    expect(a.setSfxOffset).toHaveBeenCalledWith('hall', 'door', 1000);
    expect(a.setSfxOffset).toHaveBeenCalledWith('hall', 'bell', 2000);
    release();
  });

  it('disarms the picker once its choice has been added', async () => {
    const a = actions();
    const { rerender } = render(
      <NodeAudioPanel
        projectId="p1"
        nodeId="hall"
        nodeAudio={{ sfx: [] }}
        audioFiles={FILES}
        actions={a}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    choose('Sound effect to add to hall', 'bell', 'Add');
    await waitFor(() => expect(a.assign).toHaveBeenCalledTimes(1));
    rerender(
      <NodeAudioPanel
        projectId="p1"
        nodeId="hall"
        nodeAudio={{ sfx: ['bell'] }}
        audioFiles={FILES}
        actions={a}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(a.assign).toHaveBeenCalledTimes(1);
  });

  it('stops a mix whose audio a peer has taken away', () => {
    const { rerender } = render(
      <NodeAudioPanel projectId="p1" nodeId="hall" nodeAudio={{ ambience: 'rain', sfx: [] }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play with ambience/ }));
    const bed = FakeAudio.made.find((x) => x.src.endsWith('/rain'))!;
    expect(bed.paused).toBe(false);
    rerender(<NodeAudioPanel projectId="p1" nodeId="hall" nodeAudio={{ sfx: [] }} />);
    expect(bed.paused).toBe(true);
  });

  // A peer's new timing must reach a field the author has focused but not
  // touched; otherwise tabbing away would save the old value over theirs.
  it('follows a peer’s timing into a focused, untouched field', () => {
    const a = actions();
    const panel = (ms: number) => (
      <NodeAudioPanel
        projectId="p1"
        nodeId="hall"
        nodeAudio={{ sfx: ['door'], sfxOffsets: { door: ms } }}
        audioFiles={FILES}
        actions={a}
      />
    );
    const { rerender } = render(panel(1000));
    const input = screen.getByLabelText('When SFX 1 plays, in seconds') as HTMLInputElement;
    input.focus();
    // Some typing that ends where it started leaves pending updates on the
    // input, which is when the updater runs late.
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.change(input, { target: { value: '1' } });
    rerender(panel(4000));
    expect(input.value).toBe('4');
    fireEvent.blur(input);
    expect(a.setSfxOffset).not.toHaveBeenCalled();
  });

  it('keeps what the author is typing when a peer changes the timing', () => {
    const a = actions();
    const panel = (ms: number) => (
      <NodeAudioPanel
        projectId="p1"
        nodeId="hall"
        nodeAudio={{ sfx: ['door'], sfxOffsets: { door: ms } }}
        audioFiles={FILES}
        actions={a}
      />
    );
    const { rerender } = render(panel(1000));
    const input = screen.getByLabelText('When SFX 1 plays, in seconds') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '7' } });
    rerender(panel(4000));
    expect(input.value).toBe('7');
  });

  it('refuses a timing it can’t read, and says why', async () => {
    const a = mount({ sfx: ['door'], sfxOffsets: { door: 1500 } });
    const input = screen.getByLabelText('When SFX 1 plays, in seconds') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'soon' } });
    fireEvent.blur(input);
    expect(a.setSfxOffset).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/seconds/);
    expect(input.value).toBe('1.5');
  });

  it('shows what went wrong when a change fails', async () => {
    const a = actions();
    a.clear.mockRejectedValue(new Error('Assignment not found'));
    mount({ ambience: 'rain', sfx: [] }, a);
    fireEvent.click(screen.getByLabelText('Remove ambience from hall'));
    expect((await screen.findByRole('alert')).textContent).toBe('Assignment not found');
  });

  it('is play-only without actions', () => {
    render(
      <NodeAudioPanel projectId="p1" nodeId="hall" nodeAudio={{ voiceover: 'vo1', sfx: [] }} />,
    );
    expect(screen.getByLabelText('Play Voiceover')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Replace|Attach|Remove/ })).toBeNull();
  });

  describe('play with ambience', () => {
    // Safari only lets audio start from the click itself, so nothing may
    // be awaited before the elements are created and played.
    it('starts inside the click, at the project’s levels', () => {
      render(
        <NodeAudioPanel
          projectId="p1"
          nodeId="hall"
          nodeAudio={{ voiceover: 'vo1', ambience: 'rain', sfx: [] }}
          audioFiles={FILES}
          levels={{ voiceover: 80, ambience: 40 }}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Play with ambience/ }));
      expect(FakeAudio.made).toHaveLength(2);
      const bed = FakeAudio.made.find((a) => a.src.endsWith('/rain'))!;
      const voice = FakeAudio.made.find((a) => a.src.endsWith('/vo1'))!;
      expect(bed.loop).toBe(true);
      expect(bed.volume).toBeCloseTo(0.4);
      expect(voice.volume).toBeCloseTo(0.8);
      expect(bed.paused || voice.paused).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: /Stop mix/ }));
      expect(bed.paused && voice.paused).toBe(true);
    });

    it('is offered for effects without ambience, and named for what it plays', () => {
      mount({ voiceover: 'vo1', sfx: ['door'] });
      expect(screen.getByRole('button', { name: /Play with effects/ })).toBeTruthy();
    });

    it('isn’t offered when there’s nothing to mix', () => {
      mount({ voiceover: 'vo1', sfx: [] });
      expect(screen.queryByRole('button', { name: /Play with/ })).toBeNull();
    });
  });
});
