import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveVolumes } from '@wanderline/shared';
import NodeDetail from '../NodeDetail';
import type { MixContext } from '../../lib/passageMix';

// "Play in context" on the node panel: the passage as a listener hears
// it, not clip by clip.
//
// The volume assertions here are the point of the feature. 1.6.0
// shipped every author-set volume applied twice — a 30% music bed at
// 9% — and it survived review because no editor surface reproduced the
// mix. These tests are that surface, pinned end to end from project
// settings through to `element.volume`.

vi.mock('../CollabChoiceTextInput', () => ({ default: () => null }));
vi.mock('../CollabContentTextarea', () => ({ default: () => null }));

class MockAudio {
  static instances: MockAudio[] = [];
  src: string;
  preload = '';
  volume = 1;
  loop = false;
  paused = true;
  currentTime = 0;
  private listeners: Record<string, (() => void)[]> = {};

  constructor(src?: string) {
    this.src = src ?? '';
    MockAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener() {}
  emit(type: string) {
    for (const fn of this.listeners[type] ?? []) fn();
  }
}

const originalAudio = globalThis.Audio;

/** Sounding elements, i.e. the current mix. */
const playing = () => MockAudio.instances.filter((a) => !a.paused);
const forSrc = (fragment: string) => MockAudio.instances.filter((a) => a.src.includes(fragment));

const baseProps = {
  nodeId: 'her',
  node: { content: [{ text: 'Hi.', tags: [] }], choices: [], divert: null, tags: [] },
  metadataLoaded: true,
  nodeIdSet: new Set(['her']),
  nodeIdOptions: null,
  projectId: 'p1',
  onChoiceTextEdit: vi.fn(),
  onContentEdit: vi.fn(),
  onChoiceTargetEdit: vi.fn(),
  onDivertEdit: vi.fn(),
  onMetadataSave: vi.fn(),
  yDoc: null,
  yDocReady: false,
} as unknown as React.ComponentProps<typeof NodeDetail>;

function mixContext(settings: Record<string, number> = {}, withMusic = true): MixContext {
  return {
    volumes: resolveVolumes(settings),
    backgroundMusic: withMusic ? { fileId: 'music-1', name: 'dusk.mp3' } : null,
  };
}

const fullAudio = { voiceover: 'vo-1', ambience: 'amb-1', sfx: [] };

async function clickPlayInContext() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Play in context'));
  });
}

beforeEach(() => {
  MockAudio.instances = [];
  globalThis.Audio = MockAudio as unknown as typeof Audio;
});

afterEach(() => {
  globalThis.Audio = originalAudio;
});

describe('NodeDetail — play in context', () => {
  it("plays the passage at the author's volumes, applied once", async () => {
    render(
      <NodeDetail
        {...baseProps}
        nodeAudio={fullAudio}
        mixContext={mixContext({ voiceoverVolume: 60, backgroundMusicVolume: 30 })}
      />,
    );
    await clickPlayInContext();

    expect(playing()).toHaveLength(3);
    // 0.36 and 0.09 are the squared values the released player used.
    expect(forSrc('vo-1')[0].volume).toBeCloseTo(0.6, 5);
    expect(forSrc('music-1')[0].volume).toBeCloseTo(0.3, 5);
    expect(forSrc('amb-1')[0].volume).toBeCloseTo(0.3, 5);
  });

  it('shows the levels it is mixing at, so a wrong one can be read', () => {
    render(
      <NodeDetail
        {...baseProps}
        nodeAudio={fullAudio}
        mixContext={mixContext({ voiceoverVolume: 60, backgroundMusicVolume: 25 })}
      />,
    );
    expect(screen.getByText(/60%/)).toBeTruthy();
    expect(screen.getByText(/25% · dusk\.mp3/)).toBeTruthy();
  });

  it('stops every layer when stopped', async () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />);
    await clickPlayInContext();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Stop in-context playback'));
    });

    expect(playing()).toHaveLength(0);
    expect(screen.getByLabelText('Play in context')).toBeTruthy();
  });

  it('ends when the voiceover ends — it auditions a passage, it does not advance', async () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />);
    await clickPlayInContext();
    await act(async () => forSrc('vo-1')[0].emit('ended'));

    expect(playing()).toHaveLength(0);
    expect(screen.getByLabelText('Play in context')).toBeTruthy();
  });

  it('plays a passage that has no voiceover yet', async () => {
    render(
      <NodeDetail
        {...baseProps}
        nodeAudio={{ ambience: 'amb-1', sfx: [] }}
        mixContext={mixContext()}
      />,
    );
    await clickPlayInContext();

    expect(playing()).toHaveLength(2);
    expect(screen.getByLabelText('Stop in-context playback')).toBeTruthy();
  });

  // Nothing is sounding, so the control must not claim otherwise.
  it('does not stay stuck on "playing" when every file fails to load', async () => {
    render(
      <NodeDetail
        {...baseProps}
        nodeAudio={{ ambience: 'amb-1', sfx: [] }}
        mixContext={mixContext()}
      />,
    );
    await clickPlayInContext();
    await act(async () => {
      forSrc('amb-1')[0].emit('error');
      forSrc('music-1')[0].emit('error');
    });

    expect(screen.getByLabelText('Play in context')).toBeTruthy();
    expect(playing()).toHaveLength(0);
  });

  // A bed that 404s is indistinguishable by ear from a bed the
  // narration sits comfortably over — the author would draw exactly the
  // wrong conclusion from a mix that is quietly missing a layer.
  it('says which layer failed to load, and keeps playing the rest', async () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />);
    await clickPlayInContext();
    await act(async () => forSrc('music-1')[0].emit('error'));

    expect(screen.getByText(/didn't load/)).toBeTruthy();
    // The other two carry on — a missing bed is not a dead mix.
    expect(forSrc('vo-1')[0].paused).toBe(false);
    expect(forSrc('amb-1')[0].paused).toBe(false);
    expect(screen.getByLabelText('Stop in-context playback')).toBeTruthy();
  });

  it('clears a previous failure when the mix is started again', async () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />);
    await clickPlayInContext();
    await act(async () => forSrc('music-1')[0].emit('error'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Stop in-context playback'));
    });
    await clickPlayInContext();

    expect(screen.queryByText(/didn't load/)).toBeNull();
  });

  it('a failed voiceover unwinds the mix rather than playing beds alone', async () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />);
    await clickPlayInContext();
    await act(async () => forSrc('vo-1')[0].emit('error'));

    expect(playing()).toHaveLength(0);
    expect(screen.getByLabelText('Play in context')).toBeTruthy();
  });

  it('mixes without music when the project has none', async () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext({}, false)} />);
    await clickPlayInContext();

    expect(playing()).toHaveLength(2);
    expect(forSrc('music-1')).toHaveLength(0);
  });
});

describe('NodeDetail — play in context stays exclusive', () => {
  it('auditioning a single clip silences the mix', async () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />);
    await clickPlayInContext();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Play Voiceover'));
    });

    // Exactly one element sounding: the single clip useAudition owns.
    expect(playing()).toHaveLength(1);
    expect(screen.getByLabelText('Play in context')).toBeTruthy();
  });

  it('starting the mix silences a single clip', async () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Play Ambience'));
    });
    await clickPlayInContext();

    expect(playing()).toHaveLength(3);
    expect(screen.getByLabelText('Play Ambience')).toBeTruthy();
  });

  // Switching passage or tab tears the panel down mid-play.
  it('stops on unmount', async () => {
    const { unmount } = render(
      <NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />,
    );
    await clickPlayInContext();
    unmount();

    expect(playing()).toHaveLength(0);
  });
});

describe('NodeDetail — one sound at a time across panels', () => {
  // StoryTab mounts a NodeDetail per listed passage, so two can be
  // expanded at once. Exclusivity within one panel isn't enough: two
  // three-layer mixes sounding together defeat the exact judgement the
  // control exists for, and an ambience-only mix loops with no end.
  function renderTwoPanels() {
    return render(
      <>
        <NodeDetail
          {...baseProps}
          nodeId="a"
          nodeAudio={{ voiceover: 'vo-a', sfx: [] }}
          mixContext={mixContext()}
        />
        <NodeDetail
          {...baseProps}
          nodeId="b"
          nodeAudio={{ voiceover: 'vo-b', sfx: [] }}
          mixContext={mixContext()}
        />
      </>,
    );
  }

  it("a second panel's mix silences the first", async () => {
    renderTwoPanels();
    const [playA, playB] = screen.getAllByLabelText('Play in context');
    await act(async () => fireEvent.click(playA));
    await act(async () => fireEvent.click(playB));

    expect(forSrc('vo-a')[0].paused).toBe(true);
    expect(forSrc('vo-b')[0].paused).toBe(false);
    // Two layers, both from panel B.
    expect(playing()).toHaveLength(2);
  });

  it("a clip auditioned in another panel silences the first panel's mix", async () => {
    renderTwoPanels();
    await act(async () => fireEvent.click(screen.getAllByLabelText('Play in context')[0]));
    await act(async () => fireEvent.click(screen.getAllByLabelText('Play Voiceover')[1]));

    expect(forSrc('vo-a')[0].paused).toBe(true);
    expect(playing()).toHaveLength(1);
  });
});

describe('NodeDetail — a mix that no longer describes the passage', () => {
  // Returning null from a component does not unmount it, so hiding the
  // Stop button does not stop the audio. An ambience-only mix loops
  // with no natural end: the author would be stuck with a sound and no
  // control for it.
  it('stops when the project mix lookup drops out from under it', async () => {
    const { rerender } = render(
      <NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />,
    );
    await clickPlayInContext();
    await act(async () => {
      rerender(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={null} />);
    });

    expect(playing()).toHaveLength(0);
    expect(screen.queryByLabelText('Stop in-context playback')).toBeNull();
  });

  it('stops when a volume changes underneath it', async () => {
    const { rerender } = render(
      <NodeDetail
        {...baseProps}
        nodeAudio={fullAudio}
        mixContext={mixContext({ backgroundMusicVolume: 30 })}
      />,
    );
    await clickPlayInContext();
    await act(async () => {
      rerender(
        <NodeDetail
          {...baseProps}
          nodeAudio={fullAudio}
          mixContext={mixContext({ backgroundMusicVolume: 10 })}
        />,
      );
    });

    expect(playing()).toHaveLength(0);
    expect(screen.getByLabelText('Play in context')).toBeTruthy();
  });

  it('keeps playing across a re-render that changes nothing about the mix', async () => {
    const { rerender } = render(
      <NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />,
    );
    await clickPlayInContext();
    await act(async () => {
      rerender(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />);
    });

    expect(playing()).toHaveLength(3);
  });
});

describe('NodeDetail — when the in-context control is offered', () => {
  it('is absent until the project mix is known', () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} />);
    expect(screen.queryByLabelText('Play in context')).toBeNull();
    // The per-clip rows are unaffected — they need no project context.
    expect(screen.getByLabelText('Play Voiceover')).toBeTruthy();
  });

  // Playing a bed on its own says nothing about a passage that has no
  // sound of its own.
  // A layer the player never plays could send an author off
  // re-recording a voiceover to fix masking that isn't in the build.
  it('says on screen that the app does not play ambience yet', () => {
    render(<NodeDetail {...baseProps} nodeAudio={fullAudio} mixContext={mixContext()} />);
    expect(screen.getByText(/does not play node ambience yet/)).toBeTruthy();
  });

  it('is absent for a node with only choice cues', () => {
    render(
      <NodeDetail
        {...baseProps}
        nodeAudio={{ choice1: 'c1', sfx: [] }}
        mixContext={mixContext()}
      />,
    );
    expect(screen.queryByLabelText('Play in context')).toBeNull();
    expect(screen.getByLabelText('Play Choice 1 cue')).toBeTruthy();
  });
});
