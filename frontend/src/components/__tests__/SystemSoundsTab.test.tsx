import { StrictMode } from 'react';
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
  // Used by the audition control beside each picker.
  audioFileUrl: (projectId: string, audioId: string) => `/api/${projectId}/audio/${audioId}`,
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

// Editor surface for settings.choiceAudioDelayMs. The backend and
// player already honour this (default 3000ms of silence before a
// choice option's audio starts), but nothing in the editor could
// read or write it, so an author with the wrong pacing for their
// story had no way to change it.
describe('choice-audio pause control', () => {
  it('defaults to the player’s own fallback when unset', async () => {
    mount();
    const slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    expect(slider.value).toBe('3000');
    expect(screen.getByText('3.00s')).toBeInTheDocument();
  });

  it('reflects a stored value', async () => {
    mount({ choiceAudioDelayMs: 1500 });
    const slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('1500'));
    expect(screen.getByText('1.50s')).toBeInTheDocument();
  });

  it('debounce-saves choiceAudioDelayMs when moved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    const slider = await screen.findByLabelText('Pause before choices');
    fireEvent.change(slider, { target: { value: '2000' } });

    await vi.advanceTimersByTimeAsync(300);
    expect(mockedUpdate).toHaveBeenCalledWith(
      'p1',
      { choiceAudioDelayMs: 2000 },
      expect.any(AbortSignal),
    );
    vi.useRealTimers();
  });

  // The settings contract puts a floor under this value but no ceiling,
  // so a pause set some other way (a direct API call, a future feature)
  // can sit above the 8s the slider was designed around. A fixed max
  // would clamp the thumb to 8000 while the number beside it kept
  // showing the real, higher value — and touching the slider at all
  // would silently overwrite the stored value downward the moment it
  // moved.
  it('widens the range rather than clamping a value above the slider ceiling', async () => {
    mount({ choiceAudioDelayMs: 12000 });
    const slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('12000'));
    // Past the stored value, not up to it: a ceiling of exactly 12000
    // would sit the thumb on the right edge with nowhere left to go, so
    // the one author who needs a long pause couldn't lengthen it.
    expect(Number(slider.max)).toBeGreaterThan(12000);
    expect(screen.getByText('12.00s')).toBeInTheDocument();
  });

  // The ceiling has to be held apart from the live value. Deriving `max`
  // from it meant every drag leftward pulled the ceiling down under the
  // pointer — rescaling the track mid-gesture and ratcheting the reachable
  // maximum lower each time, with no way back up short of a reload.
  it('does not pull the ceiling down as the slider is dragged', async () => {
    mount({ choiceAudioDelayMs: 12000 });
    const slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('12000'));
    const ceiling = slider.max;

    fireEvent.change(slider, { target: { value: '9000' } });
    await waitFor(() => expect(slider.value).toBe('9000'));
    expect(slider.max).toBe(ceiling);

    fireEvent.change(slider, { target: { value: '1000' } });
    await waitFor(() => expect(slider.value).toBe('1000'));
    expect(slider.max).toBe(ceiling);
  });

  // The ceiling ref lives on the component instance, and the tab isn't
  // remounted when the author switches projects — the parent route just
  // passes a new projectId. Without resetting it there, project A's raised
  // ceiling would carry into project B's slider even though B's own pause
  // is nowhere near it.
  it('does not carry a raised ceiling from one project into the next', async () => {
    mockedFetchSettings
      .mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 12000 } } as never)
      .mockResolvedValueOnce({ settings: { choiceAudioDelayMs: 3000 } } as never);
    mockedAudio.mockResolvedValue({ audioFiles: AUDIO } as never);

    const { rerender } = render(<SystemSoundsTab projectId="project-a" />);
    let slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('12000'));
    const raisedCeiling = Number(slider.max);
    expect(raisedCeiling).toBeGreaterThan(12000);

    rerender(<SystemSoundsTab projectId="project-b" />);
    slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('3000'));
    expect(Number(slider.max)).toBeLessThan(raisedCeiling);
  });

  // The reset above has to survive StrictMode's deliberate double
  // invocation of render bodies, which the plain `render`/`rerender`
  // calls in the test above don't exercise. A version of this reset
  // written as a plain ref mutation during render broke exactly here:
  // StrictMode's second invocation would see the ref already reset by
  // the first, decide projectId "didn't just change" after all, and
  // re-widen the ceiling from that same render's still-stale settings —
  // silently undoing the reset before it ever committed. Doing the
  // reset in an effect instead sidesteps this, since effects aren't
  // double-invoked by StrictMode on a dependency change (only on a
  // component's very first mount, which is a harmless no-op here).
  it('resets the ceiling across a project switch under StrictMode', async () => {
    // Keyed by projectId, not by call order: StrictMode double-invokes
    // effects on a component's initial mount (a deliberate mount →
    // cleanup → remount, to surface cleanup bugs), so fetchProjectSettings
    // fires twice for project-a's own mount before project-b is ever
    // rendered. An ordered mockResolvedValueOnce queue would hand
    // project-b's response to project-a's second, StrictMode-only call.
    const settingsByProject: Record<string, { choiceAudioDelayMs: number }> = {
      'project-a': { choiceAudioDelayMs: 12000 },
      'project-b': { choiceAudioDelayMs: 3000 },
    };
    mockedFetchSettings.mockImplementation(
      async (id: string) => ({ settings: settingsByProject[id] }) as never,
    );
    mockedAudio.mockResolvedValue({ audioFiles: AUDIO } as never);

    const { rerender } = render(
      <StrictMode>
        <SystemSoundsTab projectId="project-a" />
      </StrictMode>,
    );
    let slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('12000'));
    const raisedCeiling = Number(slider.max);
    expect(raisedCeiling).toBeGreaterThan(12000);

    rerender(
      <StrictMode>
        <SystemSoundsTab projectId="project-b" />
      </StrictMode>,
    );
    slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('3000'));
    expect(Number(slider.max)).toBeLessThan(raisedCeiling);
  });

  // Same premise as the negative case: a project written before the
  // endpoint guarded this key can hold a value that isn't a number at
  // all. Rendering it raw put NaN on the range input — React warns and
  // the control stops being controlled — and printed "NaNs" beside it.
  it('falls back to the default when the stored value is not a number', async () => {
    mount({ choiceAudioDelayMs: 'soon' as unknown as number });
    const slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('3000'));
    expect(screen.getByText('3.00s')).toBeInTheDocument();
  });

  // A third legacy case: the backend now caps a fresh write at what
  // setTimeout can represent, but a row from before that guard existed
  // can still hold more. Rendering it raw would show a pause many times
  // longer than what the player will actually produce (its own
  // setTimeout clamps the same way and fires almost immediately), so the
  // display has to cap it the same way the backend does now.
  it('caps a legacy value beyond what setTimeout can represent', async () => {
    mount({ choiceAudioDelayMs: 9_999_999_999 });
    const slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('2147483647'));
  });

  // The ceiling grows past a long stored value by adding
  // CHOICE_AUDIO_SLIDER_MAX_MS on top of it — for a value already at the
  // technical maximum, that would push the ceiling *past* what setTimeout
  // can represent, letting the slider emit a number the backend would
  // clamp back down and the player couldn't honour: the exact
  // slider/stored-value disagreement this ceiling scheme exists to avoid.
  it('does not let the ceiling itself exceed what setTimeout can represent', async () => {
    mount({ choiceAudioDelayMs: 2_147_483_647 });
    const slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('2147483647'));
    expect(Number(slider.max)).toBe(2_147_483_647);
  });

  // The other half of the same desync: min={0} on the slider can't
  // itself produce a negative value, and the endpoint now rejects one,
  // but a project written before that guard can still hold it. Without
  // clamping the resolved value, the native control would clamp its own
  // display to 0 while the text beside it kept printing the raw
  // negative number.
  it('clamps a negative stored value instead of disagreeing with the slider', async () => {
    mount({ choiceAudioDelayMs: -500 });
    const slider = (await screen.findByLabelText('Pause before choices')) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('0'));
    expect(screen.getByText('0.00s')).toBeInTheDocument();
  });
});
