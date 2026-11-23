import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NodeAudioPanel, { formatOffsetSeconds, parseOffsetSeconds } from '../NodeAudioPanel';
import type { AudioFile, VariableDeclaration } from '../../api/client';
import type { NodeAudioActions } from '../../hooks/useNodeEditor';

// The node panel's audio section. It used to be play-only: attaching or
// swapping a clip meant a trip to the Audio tab, and ambience/effects
// couldn't be heard together anywhere.

vi.mock('../../api/client', () => ({
  audioFileUrl: (projectId: string, id: string, version?: string) =>
    `/api/${projectId}/audio/${id}${version ? `?v=${version}` : ''}`,
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
    newTake: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function mount(
  nodeAudio: Parameters<typeof NodeAudioPanel>[0]['nodeAudio'],
  a = actions(),
  declaredVariables: VariableDeclaration[] = [],
  choices: Parameters<typeof NodeAudioPanel>[0]['choices'] = [],
) {
  render(
    <NodeAudioPanel
      projectId="p1"
      nodeId="hall"
      nodeAudio={nodeAudio}
      audioFiles={FILES}
      actions={a}
      declaredVariables={declaredVariables}
      choices={choices}
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
    const a = mount({ voiceover: [{ fileId: 'vo1' }], sfx: [] });
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
    const a = mount({ voiceover: [{ fileId: 'vo1' }], sfx: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    const select = screen.getByLabelText('Replacement voiceover for hall') as HTMLSelectElement;
    // The current file isn't offered as its own replacement.
    expect([...select.options].map((o) => o.value)).not.toContain('vo1');
    choose('Replacement voiceover for hall', 'vo2', 'Use');
    await waitFor(() =>
      expect(a.replace).toHaveBeenCalledWith('hall', 'voiceover', 'vo1', 'vo2', null),
    );
  });

  it('clears a slot', async () => {
    const a = mount({ ambience: [{ fileId: 'rain' }], sfx: [] });
    fireEvent.click(screen.getByLabelText('Remove ambience from hall'));
    await waitFor(() =>
      expect(a.clear).toHaveBeenCalledWith('hall', 'ambience', 'rain', undefined),
    );
  });

  it('adds, replaces and removes sound effects', async () => {
    const a = mount({ sfx: [{ fileId: 'door' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    const add = screen.getByLabelText('Sound effect to add to hall') as HTMLSelectElement;
    // Already-attached effects can't be added twice.
    expect([...add.options].map((o) => o.value)).not.toContain('door');
    choose('Sound effect to add to hall', 'bell', 'Add');
    await waitFor(() => expect(a.assign).toHaveBeenCalledWith('hall', 'sfx', 'bell'));

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    choose('Replacement for SFX 1 on hall', 'bell', 'Use');
    await waitFor(() =>
      expect(a.replace).toHaveBeenCalledWith('hall', 'sfx', 'door', 'bell', null),
    );

    fireEvent.click(screen.getByLabelText('Remove SFX 1 from hall'));
    await waitFor(() => expect(a.clear).toHaveBeenCalledWith('hall', 'sfx', 'door', undefined));
  });

  it('times a sound effect in seconds and clears it back to the start', async () => {
    const a = mount({ sfx: [{ fileId: 'door' }], sfxOffsets: { door: 1500 } });
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
        nodeAudio={{ sfx: [{ fileId: 'door' }], sfxOffsets: { door: 1500 } }}
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
        nodeAudio={{ sfx: [{ fileId: 'door' }], sfxOffsets: { door: 3000 } }}
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
    mount({ sfx: [{ fileId: 'door' }, { fileId: 'bell' }] }, a);
    const first = screen.getByLabelText('When SFX 1 plays, in seconds');
    const second = screen.getByLabelText('When SFX 2 plays, in seconds');
    fireEvent.change(first, { target: { value: '1' } });
    fireEvent.blur(first);
    fireEvent.change(second, { target: { value: '2' } });
    fireEvent.blur(second);
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalledWith('hall', 'door', 1000));
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalledWith('hall', 'bell', 2000));
    release();
  });

  // Two edits to one effect must land in order, or the older value can
  // overwrite the newer one.
  it('saves one effect’s timings in order', async () => {
    const a = actions();
    let releaseFirst!: () => void;
    a.setSfxOffset.mockImplementationOnce(() => new Promise<void>((r) => (releaseFirst = r)));
    mount({ sfx: [{ fileId: 'door' }] }, a);
    const input = screen.getByLabelText('When SFX 1 plays, in seconds');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input);
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalledTimes(1));
    // The second waits for the first.
    await new Promise((r) => setTimeout(r, 20));
    expect(a.setSfxOffset).toHaveBeenCalledTimes(1);
    releaseFirst();
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalledTimes(2));
    expect(a.setSfxOffset.mock.calls.map((c) => c[2])).toEqual([1000, 2000]);
  });

  // The stored value lags while a save is in flight; clearing a value
  // just typed, before its save lands, must still be sent.
  it('sends a change back to the stored value while a save is still in flight', async () => {
    const a = actions();
    let release!: () => void;
    a.setSfxOffset.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    mount({ sfx: [{ fileId: 'door' }] }, a);
    const input = screen.getByLabelText('When SFX 1 plays, in seconds');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    // Stored value is still empty; clearing the field must still be sent.
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalledTimes(1));
    release();
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalledTimes(2));
    expect(a.setSfxOffset.mock.calls.map((c) => c[2])).toEqual([1000, null]);
  });

  it('lets a timing that failed to save be sent again', async () => {
    const a = actions();
    a.setSfxOffset.mockRejectedValueOnce(new Error('offline'));
    mount({ sfx: [{ fileId: 'door' }] }, a);
    const input = screen.getByLabelText('When SFX 1 plays, in seconds');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    expect((await screen.findByRole('alert')).textContent).toBe('offline');
    // Same value, second attempt.
    fireEvent.blur(input);
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalledTimes(2));
    expect(a.setSfxOffset.mock.calls.map((c) => c[2])).toEqual([1000, 1000]);
  });

  it('gives up waiting on a hung timing save before replacing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const a = actions();
      a.setSfxOffset.mockImplementationOnce(() => new Promise<void>(() => {}));
      mount({ sfx: [{ fileId: 'door' }] }, a);
      const input = screen.getByLabelText('When SFX 1 plays, in seconds');
      fireEvent.change(input, { target: { value: '1' } });
      fireEvent.blur(input);
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
      choose('Replacement for SFX 1 on hall', 'bell', 'Use');
      await vi.advanceTimersByTimeAsync(10_000);
      await waitFor(() =>
        expect(a.replace).toHaveBeenCalledWith('hall', 'sfx', 'door', 'bell', null),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Carrying on would give the new take the old timing and quietly lose
  // what the author just entered.
  it('doesn’t replace an effect whose timing failed to save', async () => {
    const a = actions();
    let fail!: (e: Error) => void;
    a.setSfxOffset.mockImplementationOnce(() => new Promise<void>((_, rej) => (fail = rej)));
    mount({ sfx: [{ fileId: 'door' }] }, a);
    const input = screen.getByLabelText('When SFX 1 plays, in seconds');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    choose('Replacement for SFX 1 on hall', 'bell', 'Use');
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalled());
    fail(new Error('offline'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/didn't save/);
    expect(a.replace).not.toHaveBeenCalled();
  });

  // The timing goes with the effect, so a failed timing save mustn't
  // stop the effect being removed.
  it('still removes an effect whose timing failed to save', async () => {
    const a = actions();
    let fail!: (e: Error) => void;
    a.setSfxOffset.mockImplementationOnce(() => new Promise<void>((_, rej) => (fail = rej)));
    mount({ sfx: [{ fileId: 'door' }] }, a);
    const input = screen.getByLabelText('When SFX 1 plays, in seconds');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByLabelText('Remove SFX 1 from hall'));
    await waitFor(() => expect(a.setSfxOffset).toHaveBeenCalled());
    fail(new Error('offline'));
    await waitFor(() => expect(a.clear).toHaveBeenCalledWith('hall', 'sfx', 'door', undefined));
  });

  it('holds a replace until the effect’s timing has saved', async () => {
    const a = actions();
    let release!: () => void;
    a.setSfxOffset.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    mount({ sfx: [{ fileId: 'door' }] }, a);
    const input = screen.getByLabelText('When SFX 1 plays, in seconds');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    choose('Replacement for SFX 1 on hall', 'bell', 'Use');
    await new Promise((r) => setTimeout(r, 20));
    expect(a.replace).not.toHaveBeenCalled();
    release();
    await waitFor(() =>
      expect(a.replace).toHaveBeenCalledWith('hall', 'sfx', 'door', 'bell', null),
    );
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
        nodeAudio={{ sfx: [{ fileId: 'bell' }] }}
        audioFiles={FILES}
        actions={a}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(a.assign).toHaveBeenCalledTimes(1);
  });

  it('stops a mix whose audio a peer has taken away', () => {
    const { rerender } = render(
      <NodeAudioPanel
        projectId="p1"
        nodeId="hall"
        nodeAudio={{ ambience: [{ fileId: 'rain' }], sfx: [] }}
      />,
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
        nodeAudio={{ sfx: [{ fileId: 'door' }], sfxOffsets: { door: ms } }}
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
        nodeAudio={{ sfx: [{ fileId: 'door' }], sfxOffsets: { door: ms } }}
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
    const a = mount({ sfx: [{ fileId: 'door' }], sfxOffsets: { door: 1500 } });
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
    mount({ ambience: [{ fileId: 'rain' }], sfx: [] }, a);
    fireEvent.click(screen.getByLabelText('Remove ambience from hall'));
    expect((await screen.findByRole('alert')).textContent).toBe('Assignment not found');
  });

  describe('new take', () => {
    const upload = (label: string) => {
      fireEvent.click(screen.getByLabelText(label));
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['x'], 'take-2.mp3', { type: 'audio/mpeg' });
      fireEvent.change(input, { target: { files: [file] } });
      return file;
    };

    afterEach(() => vi.restoreAllMocks());

    it('uploads over the file once the author confirms', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const a = mount({ voiceover: [{ fileId: 'vo1' }], sfx: [] });
      const file = upload('Upload a new take of voiceover for hall');
      // The prompt names what's being replaced and warns it's everywhere.
      expect(confirm.mock.calls[0][0]).toMatch(/vo1\.mp3.*take-2\.mp3.*Every passage/);
      await waitFor(() => expect(a.newTake).toHaveBeenCalledWith('vo1', file));
    });

    it('does nothing if the author backs out', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const a = mount({ sfx: [{ fileId: 'door' }] });
      upload('Upload a new take of SFX 1 for hall');
      expect(a.newTake).not.toHaveBeenCalled();
    });
  });

  // A new take keeps the file's id, so the audition URL has to change
  // with it or a loaded player replays the old take.
  it('versions audition URLs by the stored file', () => {
    render(
      <NodeAudioPanel
        projectId="p1"
        nodeId="hall"
        nodeAudio={{ ambience: [{ fileId: 'rain' }], sfx: [] }}
        audioFiles={[{ ...file('rain', 'ambience'), filename: 'abc.mp3' } as AudioFile]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play with ambience/ }));
    expect(FakeAudio.made[0].src).toBe('/api/p1/audio/rain?v=abc.mp3');
  });

  it('is play-only without actions', () => {
    render(
      <NodeAudioPanel
        projectId="p1"
        nodeId="hall"
        nodeAudio={{ voiceover: [{ fileId: 'vo1' }], sfx: [] }}
      />,
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
          nodeAudio={{ voiceover: [{ fileId: 'vo1' }], ambience: [{ fileId: 'rain' }], sfx: [] }}
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
      mount({ voiceover: [{ fileId: 'vo1' }], sfx: [{ fileId: 'door' }] });
      expect(screen.getByRole('button', { name: /Play with effects/ })).toBeTruthy();
    });

    it('isn’t offered when there’s nothing to mix', () => {
      mount({ voiceover: [{ fileId: 'vo1' }], sfx: [] });
      expect(screen.queryByRole('button', { name: /Play with/ })).toBeNull();
    });
  });

  describe('variable-conditioned variants', () => {
    const MOOD: VariableDeclaration = {
      name: 'mood',
      type: 'string',
      initialValue: { kind: 'literal', value: 'cheerful' },
      isConst: false,
    };
    const HAS_KEY: VariableDeclaration = {
      name: 'hasKey',
      type: 'bool',
      initialValue: { kind: 'literal', value: false },
      isConst: false,
    };

    it('does not offer "add a conditional variant" when no variables are declared', () => {
      mount({ sfx: [] }, actions(), []);
      expect(screen.queryByText(/Add conditional variant/)).toBeNull();
    });

    it('builds a condition, then picks a file, then assigns with that condition', async () => {
      const a = mount({ sfx: [] }, actions(), [MOOD]);
      fireEvent.click(screen.getAllByText('+ Add conditional variant…')[SLOT_INDEX.voiceover]);

      fireEvent.change(screen.getByLabelText('Comparison operator'), { target: { value: '==' } });
      fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'angry' } });
      fireEvent.click(screen.getByRole('button', { name: 'Next: pick a file' }));

      expect(screen.getByText('when mood == "angry", play')).toBeTruthy();
      choose('Voiceover to play when mood == "angry" on hall', 'vo1', 'Add');

      await waitFor(() =>
        expect(a.assign).toHaveBeenCalledWith('hall', 'voiceover', 'vo1', {
          variable: 'mood',
          operator: '==',
          value: 'angry',
        }),
      );
    });

    it('offers only equality for a string/bool variable, and a true/false dropdown for bool', () => {
      mount({ sfx: [] }, actions(), [HAS_KEY]);
      fireEvent.click(screen.getAllByText('+ Add conditional variant…')[SLOT_INDEX.voiceover]);

      const operatorSelect = screen.getByLabelText('Comparison operator') as HTMLSelectElement;
      expect([...operatorSelect.options].map((o) => o.value)).toEqual(['==', '!=']);

      const valueSelect = screen.getByLabelText('Value') as HTMLSelectElement;
      expect([...valueSelect.options].map((o) => o.value)).toEqual(['', 'true', 'false']);
    });

    it('offers every comparison operator for a number variable', () => {
      mount({ sfx: [] }, actions(), [
        {
          name: 'gold',
          type: 'number',
          initialValue: { kind: 'literal', value: 0 },
          isConst: false,
        },
      ]);
      fireEvent.click(screen.getAllByText('+ Add conditional variant…')[SLOT_INDEX.voiceover]);
      const operatorSelect = screen.getByLabelText('Comparison operator') as HTMLSelectElement;
      expect([...operatorSelect.options].map((o) => o.value)).toEqual([
        '==',
        '!=',
        '<',
        '<=',
        '>',
        '>=',
      ]);
    });

    it('labels a conditioned variant’s row with its condition', () => {
      mount(
        {
          voiceover: [
            { fileId: 'vo1', condition: { variable: 'mood', operator: '==', value: 'angry' } },
          ],
          sfx: [],
        },
        actions(),
        [MOOD],
      );
      expect(screen.getByText('Voiceover — when mood == "angry"')).toBeTruthy();
    });

    // Regression (found in review): replacing one of two variants that
    // share the same file on the same slot must scope to THAT variant's
    // own condition, or the backend's bulk-reassign (which otherwise
    // swaps every variant of the slot sharing fromFileId) would also
    // replace the sibling variant despite the UI targeting only this row.
    it('passes this row’s own condition to replace, not the default/unscoped case', async () => {
      const a = mount(
        {
          voiceover: [
            { fileId: 'vo1' },
            { fileId: 'vo1', condition: { variable: 'mood', operator: '==', value: 'angry' } },
          ],
          sfx: [],
        },
        actions(),
        [MOOD],
      );
      const replaceButtons = screen.getAllByRole('button', { name: 'Replace' });
      // Row 0 is the default/unconditioned variant.
      fireEvent.click(replaceButtons[0]);
      choose('Replacement voiceover for hall', 'vo2', 'Use');
      await waitFor(() =>
        expect(a.replace).toHaveBeenCalledWith('hall', 'voiceover', 'vo1', 'vo2', null),
      );
    });

    it('passes the conditioned variant’s own condition to replace, not null', async () => {
      const a = mount(
        {
          voiceover: [
            { fileId: 'vo1' },
            { fileId: 'vo1', condition: { variable: 'mood', operator: '==', value: 'angry' } },
          ],
          sfx: [],
        },
        actions(),
        [MOOD],
      );
      const replaceButtons = screen.getAllByRole('button', { name: 'Replace' });
      // Row 1 is the conditioned variant.
      fireEvent.click(replaceButtons[1]);
      choose('Replacement voiceover — when mood == "angry" for hall', 'vo2', 'Use');
      await waitFor(() =>
        expect(a.replace).toHaveBeenCalledWith('hall', 'voiceover', 'vo1', 'vo2', {
          variable: 'mood',
          operator: '==',
          value: 'angry',
        }),
      );
    });

    // Regression: onSubmit succeeding used to leave the builder open
    // pointing at the already-saved condition — a second file pick
    // there re-sent the identical condition and 409'd.
    it('closes the builder back to its button once a conditioned variant is added', async () => {
      const a = mount({ sfx: [] }, actions(), [MOOD]);
      fireEvent.click(screen.getAllByText('+ Add conditional variant…')[SLOT_INDEX.voiceover]);
      fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'angry' } });
      fireEvent.click(screen.getByRole('button', { name: 'Next: pick a file' }));
      choose('Voiceover to play when mood == "angry" on hall', 'vo1', 'Add');

      await waitFor(() => expect(a.assign).toHaveBeenCalledTimes(1));
      // Back to the button, not still open on the file picker.
      expect(screen.queryByText(/when mood/)).toBeNull();
      expect(screen.getAllByText('+ Add conditional variant…')[SLOT_INDEX.voiceover]).toBeTruthy();
    });

    // Regression: a slot with only conditioned variants (no default
    // yet) used to be excluded from "Attach audio…" entirely, with no
    // in-panel way to add the fallback afterward.
    it('still offers "Attach audio…" for a slot that has a conditioned variant but no default', () => {
      mount(
        {
          voiceover: [
            { fileId: 'vo1', condition: { variable: 'mood', operator: '==', value: 'angry' } },
          ],
          sfx: [],
        },
        actions(),
        [MOOD],
      );
      fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
      expect(screen.getByLabelText('Voiceover to attach to hall')).toBeTruthy();
    });

    // sfx has its own entries independently gated by condition (no
    // single-default-slot concept like voiceover/ambience/choice1/2),
    // so it gets its own affordance rather than one SLOTS row per type.
    it('builds a conditioned sound effect and assigns it with that condition', async () => {
      const a = mount({ sfx: [] }, actions(), [MOOD]);
      fireEvent.click(screen.getByText('+ Add conditional sound effect…'));

      fireEvent.change(screen.getByLabelText('Comparison operator'), { target: { value: '==' } });
      fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'angry' } });
      fireEvent.click(screen.getByRole('button', { name: 'Next: pick a file' }));

      expect(screen.getByText('when mood == "angry", play')).toBeTruthy();
      choose('Sound effect to play when mood == "angry" on hall', 'door', 'Add');

      await waitFor(() =>
        expect(a.assign).toHaveBeenCalledWith('hall', 'sfx', 'door', {
          variable: 'mood',
          operator: '==',
          value: 'angry',
        }),
      );
    });

    // Regression: GET /assignments used to drop condition for sfx
    // entirely, so a conditioned sfx row was indistinguishable from a
    // plain one in the editor, and Remove always cleared the
    // unconditioned row regardless of which one was clicked.
    it('labels a conditioned sfx row with its condition, distinct from a plain one', () => {
      mount(
        {
          sfx: [
            { fileId: 'bell' },
            { fileId: 'door', condition: { variable: 'mood', operator: '==', value: 'angry' } },
          ],
        },
        actions(),
        [MOOD],
      );
      expect(screen.getByText('SFX 1')).toBeTruthy();
      expect(screen.getByText('SFX 2 — when mood == "angry"')).toBeTruthy();
    });

    it('clears a conditioned sfx row with its own condition, not the default', async () => {
      const a = mount(
        {
          sfx: [
            { fileId: 'bell' },
            { fileId: 'door', condition: { variable: 'mood', operator: '==', value: 'angry' } },
          ],
        },
        actions(),
        [MOOD],
      );
      fireEvent.click(screen.getByLabelText('Remove SFX 2 — when mood == "angry" from hall'));
      await waitFor(() =>
        expect(a.clear).toHaveBeenCalledWith('hall', 'sfx', 'door', {
          variable: 'mood',
          operator: '==',
          value: 'angry',
        }),
      );
      expect(a.clear).not.toHaveBeenCalledWith('hall', 'sfx', 'bell', undefined);
    });

    // Regression: sfx timing is stored keyed by file id alone, so the
    // same file used twice under different conditions would silently
    // share one timing value — excluding already-used files avoids
    // ever creating that state, matching the plain "Add sound effect"
    // flow's existing exclude behavior.
    it('does not offer an already-attached file when adding a conditioned sound effect', () => {
      mount({ sfx: [{ fileId: 'door' }] }, actions(), [MOOD]);
      fireEvent.click(screen.getByText('+ Add conditional sound effect…'));
      fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'angry' } });
      fireEvent.click(screen.getByRole('button', { name: 'Next: pick a file' }));
      const picker = screen.getByLabelText(
        'Sound effect to play when mood == "angry" on hall',
      ) as HTMLSelectElement;
      expect([...picker.options].map((o) => o.value)).not.toContain('door');
    });
  });
});

// Per-choice audio addressed by the choice's own stable id (DEV-199
// stable-id rollout) — generalizes the old fixed "Choice 1 cue" /
// "Choice 2 cue" ordinal slots into slots anchored to an actual
// choice, so a cue can't silently end up on the wrong choice after a
// reorder.
describe('per-choice audio cues', () => {
  it('offers no choice-cue row when the node has no choices', () => {
    mount({ sfx: [] }, actions(), [], []);
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    expect(screen.queryByText('Choice 1 cue')).toBeNull();
  });

  it('addresses the first choice by its own id, not the ordinal slot, when it has one', async () => {
    const a = mount({ sfx: [] }, actions(), [], [{ text: 'Go', target: 'b', id: 'choice-abc' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    fireEvent.change(screen.getByLabelText('Choice 1 cue to attach to hall'), {
      target: { value: 'vo1' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Attach' })[SLOT_INDEX.choice1]);
    await waitFor(() => expect(a.assign).toHaveBeenCalledWith('hall', 'choice:choice-abc', 'vo1'));
  });

  it('falls back to the ordinal choice1 slot when the choice has no id', async () => {
    const a = mount({ sfx: [] }, actions(), [], [{ text: 'Go', target: 'b' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    fireEvent.change(screen.getByLabelText('Choice 1 cue to attach to hall'), {
      target: { value: 'vo1' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Attach' })[SLOT_INDEX.choice1]);
    await waitFor(() => expect(a.assign).toHaveBeenCalledWith('hall', 'choice1', 'vo1'));
  });

  // Regression: a choice's id is minted fresh by randomUUID() on
  // every parse — NOT stable across a re-upload of the same source.
  // A choice that now HAS an id but has a pre-existing cue under the
  // ordinal slot (attached before its current id existed) must keep
  // showing — and keep being editable by — that ordinal data, not
  // silently hide it behind an empty id-addressed slot.
  it('still shows and edits a pre-existing ordinal cue for a choice that now has an id', async () => {
    const a = mount(
      { choice1: [{ fileId: 'vo1' }], sfx: [] },
      actions(),
      [],
      [{ text: 'Go', target: 'b', id: 'choice-abc' }],
    );
    expect(screen.getByText('Choice 1 cue')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove choice 1 cue from hall'));
    await waitFor(() => expect(a.clear).toHaveBeenCalledWith('hall', 'choice1', 'vo1', undefined));
  });

  it('renders an attached per-choice-id cue and clears it by that same id, not the ordinal slot', async () => {
    const a = mount(
      { choices: { 'choice-abc': [{ fileId: 'vo1' }] }, sfx: [] },
      actions(),
      [],
      [{ text: 'Go', target: 'b', id: 'choice-abc' }],
    );
    expect(screen.getByText('Choice 1 cue')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove choice 1 cue from hall'));
    await waitFor(() =>
      expect(a.clear).toHaveBeenCalledWith('hall', 'choice:choice-abc', 'vo1', undefined),
    );
  });

  it('shows "Choice 2 cue" for the second choice, addressed by ITS id', async () => {
    const a = mount(
      { sfx: [] },
      actions(),
      [],
      [
        { text: 'First', target: 'b', id: 'first-id' },
        { text: 'Second', target: 'c', id: 'second-id' },
      ],
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach audio…' }));
    fireEvent.change(screen.getByLabelText('Choice 2 cue to attach to hall'), {
      target: { value: 'vo1' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Attach' })[SLOT_INDEX.choice2]);
    await waitFor(() => expect(a.assign).toHaveBeenCalledWith('hall', 'choice:second-id', 'vo1'));
  });
});
