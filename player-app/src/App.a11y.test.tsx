import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, createEvent, waitFor } from '@testing-library/react';
import App from './App';

// Accessibility regressions found by audit against a released build.
// Each block below fails on the pre-fix code:
//
//   - The window keydown handler called preventDefault() for Space,
//     Enter, the arrows and Backspace without ever looking at the event
//     target, so every button, checkbox and slider in the player was
//     dead to the keyboard — pressing Enter on the Settings cog
//     advanced the story instead of opening Settings.
//   - role="application" on the root suppressed the screen-reader
//     virtual cursor, and the captions ARE the transcript of an audio
//     medium.
//   - Cycling choices announced nothing, and with captions off a
//     passage change announced nothing either.
//   - The password field had no accessible name and its error was
//     never spoken.

class MockAudio {
  src: string;
  preload = '';
  volume = 1;
  loop = false;
  paused = true;
  currentTime = 0;
  duration = 0;
  oncanplaythrough: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onpause: (() => void) | null = null;
  constructor(src?: string) {
    this.src = src ?? '';
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    setTimeout(() => this.oncanplaythrough?.(), 0);
  }
  addEventListener() {}
  removeEventListener() {}
}

// A passage whose only way onward is a divert: no choice list exists,
// so there is nothing for the arrows to hand focus to.
const divertOnlyStory = {
  id: 'a11y-divert',
  title: 'A11y Divert',
  audioBaseUrl: './audio/',
  startNode: 'start',
  nodes: {
    start: {
      id: 'start',
      type: 'knot',
      content: [{ text: 'Welcome to the story.' }],
      choices: [],
      divert: 'onward',
      tags: [],
      audio: { voiceover: 'start.mp3' },
    },
    onward: {
      id: 'onward',
      type: 'knot',
      content: [{ text: 'Onward.' }],
      choices: [],
      divert: 'END',
      tags: [],
    },
  },
};

const threeChoiceStory = {
  id: 'a11y-story',
  title: 'A11y Story',
  audioBaseUrl: './audio/',
  startNode: 'start',
  nodes: {
    start: {
      id: 'start',
      type: 'knot',
      content: [{ text: 'Welcome to the story.' }],
      choices: [
        { text: 'Go left', target: 'left' },
        { text: 'Go right', target: 'right' },
        { text: 'Stay put', target: 'stay' },
      ],
      divert: null,
      tags: [],
      audio: { voiceover: 'start.mp3' },
    },
    left: {
      id: 'left',
      type: 'knot',
      content: [{ text: 'You went left.' }],
      choices: [],
      divert: 'END',
      tags: [],
    },
    right: {
      id: 'right',
      type: 'knot',
      content: [{ text: 'You went right.' }],
      choices: [],
      divert: 'END',
      tags: [],
    },
    stay: {
      id: 'stay',
      type: 'knot',
      content: [{ text: 'You stayed put.' }],
      choices: [],
      divert: 'END',
      tags: [],
    },
  },
};

const echoStory = {
  id: 'echo-story',
  title: 'Echo Story',
  audioBaseUrl: './audio/',
  startNode: 'hubA',
  nodes: {
    hubA: {
      id: 'hubA',
      type: 'knot',
      content: [{ text: 'Room A.' }],
      choices: [
        { text: 'Look around', target: 'hubB' },
        { text: 'Go back', target: 'done' },
      ],
      divert: null,
      tags: [],
      audio: { voiceover: 'a.mp3' },
    },
    hubB: {
      id: 'hubB',
      type: 'knot',
      content: [{ text: 'Room B.' }],
      choices: [
        { text: 'Look around', target: 'done' },
        { text: 'Go back', target: 'done' },
      ],
      divert: null,
      tags: [],
      audio: { voiceover: 'b.mp3' },
    },
    done: {
      id: 'done',
      type: 'knot',
      content: [{ text: 'Done.' }],
      choices: [],
      divert: 'END',
      tags: [],
    },
  },
};

// An Ink knot that diverts to itself: "circle the room again".
// Navigating here changes neither the node nor the armed choice.
const loopStory = {
  id: 'loop-story',
  title: 'Loop Story',
  audioBaseUrl: './audio/',
  startNode: 'loop',
  nodes: {
    loop: {
      id: 'loop',
      type: 'knot',
      content: [{ text: 'You circle the room.' }],
      choices: [
        { text: 'Circle again', target: 'loop' },
        { text: 'Leave', target: 'done' },
      ],
      divert: null,
      tags: [],
      audio: { voiceover: 'loop.mp3' },
    },
    done: {
      id: 'done',
      type: 'knot',
      content: [{ text: 'You leave.' }],
      choices: [],
      divert: 'END',
      tags: [],
    },
  },
};

// Two passages offering the same option, with the same wording, at the
// same index: React keeps the very same DOM button across the
// navigation, so focus survives it.
const stickyStory = {
  id: 'sticky-story',
  title: 'Sticky Story',
  audioBaseUrl: './audio/',
  startNode: 'one',
  nodes: {
    one: {
      id: 'one',
      type: 'knot',
      content: [{ text: 'Room one.' }],
      choices: [
        // Identical target AND text at index 0 in both rooms, so this
        // button keeps its React key — and its DOM focus — across the
        // navigation.
        { text: 'Look', target: 'done' },
        { text: 'Onward', target: 'two' },
      ],
      divert: null,
      tags: [],
      audio: { voiceover: 'one.mp3' },
    },
    two: {
      id: 'two',
      type: 'knot',
      content: [{ text: 'Room two.' }],
      choices: [
        { text: 'Look', target: 'done' },
        { text: 'Onward', target: 'done' },
      ],
      divert: null,
      tags: [],
      audio: { voiceover: 'two.mp3' },
    },
    done: {
      id: 'done',
      type: 'knot',
      content: [{ text: 'Done.' }],
      choices: [],
      divert: 'END',
      tags: [],
    },
  },
};

const originalAudio = globalThis.Audio;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.Audio = MockAudio as unknown as typeof Audio;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  // startStory arms a bare setTimeout(300). With real timers it fires
  // after teardown against jsdom's Audio and throws an uncaught error
  // that fails CI with every test still reported as passing. Drain
  // before cleanup.
  vi.runOnlyPendingTimers();
  cleanup();
  vi.useRealTimers();
  globalThis.Audio = originalAudio;
  vi.restoreAllMocks();
  delete (window as unknown as { __WANDERLINE_STORY__?: unknown }).__WANDERLINE_STORY__;
});

async function renderStory(story: unknown = threeChoiceStory) {
  (window as unknown as { __WANDERLINE_STORY__?: unknown }).__WANDERLINE_STORY__ = story;
  render(<App />);
  const startButton = await screen.findByLabelText('Start the story');
  fireEvent.click(startButton);
  await screen.findByRole('main');
}

/**
 * The screen-reader-only status region that carries choice
 * announcements — identified by content, since the player renders
 * several `role="status"` elements (buffering, "The End").
 */
function choiceStatusRegion(): HTMLElement {
  const regions = screen.getAllByRole('status');
  const match = regions.find((r) => /choice/i.test(r.textContent ?? ''));
  if (!match) throw new Error('no choice status region found');
  return match;
}

/** Dispatch a keydown on `el` and report whether it was cancelled. */
function keyDownAndCheckCancelled(el: Element, key: string): boolean {
  const event = createEvent.keyDown(el, { key, bubbles: true });
  fireEvent(el, event);
  return event.defaultPrevented;
}

describe('keyboard access to on-screen controls', () => {
  it('does not cancel Enter aimed at a button while the passage has choices', async () => {
    await renderStory();

    const settingsCog = screen.getByLabelText('Settings');
    const cancelled = keyDownAndCheckCancelled(settingsCog, 'Enter');

    // The browser turns an uncancelled Enter on a button into a click.
    // Cancelling it left the cog unopenable by keyboard.
    expect(cancelled).toBe(false);
    // And the global "confirm the armed choice" shortcut must not have
    // hijacked the press: we are still on the opening passage.
    expect(screen.getByText('Welcome to the story.')).toBeInTheDocument();
    expect(screen.queryByText('You went left.')).not.toBeInTheDocument();
  });

  it('does not cancel Enter aimed at a choice button', async () => {
    await renderStory();

    const choice = screen.getByLabelText('Choice 3: Stay put');
    expect(keyDownAndCheckCancelled(choice, 'Enter')).toBe(false);
    // Enter must not have navigated via the armed choice (index 0).
    expect(screen.queryByText('You went left.')).not.toBeInTheDocument();
  });

  it('does not cancel Space aimed at the auto-advance checkbox', async () => {
    await renderStory();

    fireEvent.click(screen.getByLabelText('Settings'));
    const checkbox = screen.getByRole('checkbox', { name: /advance automatically/i });

    // Space is the only key that toggles a checkbox. Cancelling it made
    // this control impossible to change by keyboard at all.
    expect(keyDownAndCheckCancelled(checkbox, ' ')).toBe(false);
  });

  it('does not cancel the arrow keys aimed at a volume slider', async () => {
    await renderStory();

    fireEvent.click(screen.getByLabelText('Settings'));
    const slider = screen.getByLabelText(/narration volume/i);

    expect(keyDownAndCheckCancelled(slider, 'ArrowDown')).toBe(false);
    expect(keyDownAndCheckCancelled(slider, 'ArrowUp')).toBe(false);
  });

  it('still handles global shortcuts when nothing interactive is focused', async () => {
    await renderStory();

    // Enter on the page body confirms the armed choice (index 0).
    const event = createEvent.keyDown(document.body, { key: 'Enter', bubbles: true });
    fireEvent(document.body, event);

    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText('You went left.')).toBeInTheDocument();
  });

  it('still handles the arrow keys globally to cycle choices', async () => {
    await renderStory();

    const event = createEvent.keyDown(document.body, { key: 'ArrowDown', bubbles: true });
    fireEvent(document.body, event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByLabelText('Choice 2: Go right')).toHaveAttribute('aria-current', 'true'),
    );
  });

  it('confirms before Restart wipes saves, and honours a cancel', async () => {
    // The target guard handed Space and Enter back to buttons, which
    // made the header's Restart reachable by keyboard for the first
    // time — and it clears every manual save with no undo. A listener
    // tabbing the toolbar for the pause control lands on it and presses
    // Space, which the footer advertises as pause.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      localStorage.setItem(
        'wanderline_a11y-story_slots',
        JSON.stringify([
          {
            id: 'manual-1',
            name: 'Chapter 2',
            nodeId: 'left',
            history: ['start'],
            savedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      );
      await renderStory();

      const restart = screen.getByRole('button', { name: 'Restart story from beginning' });
      restart.focus();
      fireEvent.keyDown(restart, { key: ' ', bubbles: true });
      fireEvent.click(restart);

      expect(confirmSpy).toHaveBeenCalled();
      // Cancelled: the save survives.
      expect(localStorage.getItem('wanderline_a11y-story_slots')).toContain('Chapter 2');
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('hands focus to the choice list when the arrows come from another control', async () => {
    // The arrows move the armed choice; Enter activates whatever has
    // focus. Both global at once, the two disagree — arrow twice with
    // focus on Play, hear "Choice 3 of 3", press Enter, and playback
    // toggles.
    //
    // Standing the arrows down instead cost more than it bought: every
    // browser leaves focus on a <button> after a pointer click, so a
    // listener who clicked Play lost cycling entirely with nothing to
    // say why. Moving focus INTO the list makes the two agree by
    // construction, which is what the stand-down was for.
    await renderStory({ ...threeChoiceStory, settings: { showChoiceList: false } });

    const playButton = screen.getByRole('button', { name: /^(Play|Pause|Loading) / });
    const event = createEvent.keyDown(playButton, { key: 'ArrowDown', bubbles: true });
    fireEvent(playButton, event);

    // Focus moved into the list, and the arrow still cycled.
    await waitFor(() =>
      expect(screen.getByLabelText('Choice 2: Go right')).toHaveAttribute('aria-current', 'true'),
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Choice 2: Go right'));
  });

  it('leaves the arrows alone when there is no choice list to move into', async () => {
    // A passage with a plain divert has no armed choice to hand focus
    // to, so the press stays with whatever had it rather than cycling
    // something that is not on screen.
    await renderStory(divertOnlyStory);

    const playButton = screen.getByRole('button', { name: /^(Play|Pause|Loading) / });
    playButton.focus();
    const event = createEvent.keyDown(playButton, { key: 'ArrowDown', bubbles: true });
    fireEvent(playButton, event);

    expect(event.defaultPrevented).toBe(false);
    // Focus stays where it was rather than being pulled somewhere.
    expect(document.activeElement).toBe(playButton);
  });

  it('still cycles choices with the arrows from inside the list', async () => {
    // Inside the list the two cannot disagree: focus follows the armed
    // choice, so the arrows stay global there.
    await renderStory();

    const first = screen.getByLabelText('Choice 1: Go left');
    first.focus();
    const event = createEvent.keyDown(first, { key: 'ArrowDown', bubbles: true });
    fireEvent(first, event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByLabelText('Choice 2: Go right')).toHaveAttribute('aria-current', 'true'),
    );
  });

  it('still goes back on Backspace while focus sits on a button', async () => {
    await renderStory();

    fireEvent.click(screen.getByLabelText('Choice 2: Go right'));
    await screen.findByText('You went right.');

    const backButton = screen.getByLabelText('Go back to the previous part');
    fireEvent.keyDown(backButton, { key: 'Backspace', bubbles: true });

    expect(await screen.findByText('Welcome to the story.')).toBeInTheDocument();
  });

  it('still pauses on Space while a volume slider has focus', async () => {
    // A range input has no default action for Space or Enter, so
    // yielding them to it meant Space did nothing at all — worse, the
    // page scrolled — where it used to pause narration.
    await renderStory();
    fireEvent.click(screen.getByLabelText('Settings'));
    const slider = screen.getByLabelText(/narration volume/i);

    expect(keyDownAndCheckCancelled(slider, ' ')).toBe(true);
  });

  it('does not restart the story on r inside the settings panel', async () => {
    // restart() also clears every save slot, and the save/load UI lives
    // in this panel — so with focus on a Load or Rename button, one
    // stray keystroke wiped the saves it was showing.
    await renderStory();
    fireEvent.click(screen.getByLabelText('Choice 2: Go right'));
    await screen.findByText('You went right.');

    fireEvent.click(screen.getByLabelText('Settings'));
    fireEvent.keyDown(screen.getByLabelText(/narration volume/i), { key: 'r', bubbles: true });

    expect(screen.getByText('You went right.')).toBeInTheDocument();
    expect(screen.queryByText('Welcome to the story.')).not.toBeInTheDocument();
  });

  it('still pauses on Space inside the settings panel', async () => {
    // The allowlist keeps the playback keys: reaching for pause while
    // adjusting the volume is exactly what a listener does.
    await renderStory();
    fireEvent.click(screen.getByLabelText('Settings'));

    // The checkbox claims Space for itself; the panel's non-claiming
    // controls do not, so the shortcut still reaches the player.
    const panel = document.getElementById('settings-panel')!;
    const heading = panel.querySelector('h3')!;
    const event = createEvent.keyDown(heading, { key: ' ', bubbles: true });
    fireEvent(heading, event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('does not move the story on Enter inside the settings panel', async () => {
    // The panel is a task of its own. A checkbox ignores Enter, so
    // without this the press fell through to "confirm the armed
    // choice" and advanced the passage behind the open panel.
    await renderStory();
    fireEvent.click(screen.getByLabelText('Settings'));
    const checkbox = screen.getByRole('checkbox', { name: /advance automatically/i });

    fireEvent.keyDown(checkbox, { key: 'Enter', bubbles: true });

    expect(screen.getByText('Welcome to the story.')).toBeInTheDocument();
    expect(screen.queryByText('You went left.')).not.toBeInTheDocument();
  });

  it('still runs the global shortcut with focus on the story region', async () => {
    // Fires on <main tabIndex={-1}>, not a button — which is the point.
    // It pins the deliberate exclusion of bare [tabindex] from the
    // interactive selector: <main> is the post-choice focus target and
    // must keep receiving the shortcuts. Named for a button, it
    // advertised coverage it does not have and hid the coverage it
    // does.
    //
    // Outside the panel the global shortcut is intact: a <button>
    // claims Enter, but the Back button is only rendered once there is
    // history, so use the story-region heading area — nothing
    // interactive — to prove the shortcut still runs.
    await renderStory();

    const event = createEvent.keyDown(screen.getByRole('main'), { key: 'Enter', bubbles: true });
    fireEvent(screen.getByRole('main'), event);

    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText('You went left.')).toBeInTheDocument();
  });

  it('still routes a headphone media key while a volume slider has focus', async () => {
    // A range input is not text entry. Treating it as such dropped
    // every headphone press until focus left the slider — the listener
    // nudges the volume, then their earbud button does nothing.
    await renderStory();
    fireEvent.click(screen.getByLabelText('Settings'));
    const slider = screen.getByLabelText(/narration volume/i);

    vi.advanceTimersByTime(200);
    fireEvent.keyDown(slider, { key: 'MediaTrackNext', bubbles: true });

    expect(await screen.findByText('You went left.')).toBeInTheDocument();
  });

  it('still routes a headphone media key while focus sits on a button', async () => {
    await renderStory();

    // A listener taps the on-screen Play button, which leaves focus on
    // it, then presses the inline button on their earbuds. Media keys
    // are not consumed by buttons, so the transport fallback must keep
    // working here — guarding it as broadly as the shortcut handler
    // would silently kill the product's signature interaction.
    const playButton = screen.getByRole('button', { name: /^(Play|Pause|Loading) / });
    // The transport dedupe compares against performance.now(), which the
    // fake clock starts at 0 — without this the very first press looks
    // like a duplicate of a press at time zero and is dropped.
    vi.advanceTimersByTime(200);
    fireEvent.keyDown(playButton, { key: 'MediaTrackNext', bubbles: true });

    expect(await screen.findByText('You went left.')).toBeInTheDocument();
  });
});

describe('screen-reader structure', () => {
  it('does not put role="application" on the page', async () => {
    await renderStory();

    // role="application" suppresses the NVDA/JAWS virtual cursor, so a
    // blind listener cannot arrow through the caption text — the only
    // transcript of an audio medium — or use heading/landmark quick-nav.
    expect(document.querySelector('[role="application"]')).toBeNull();
  });

  it('gives the root container no role, so browse mode survives', async () => {
    // role="application" on the root suppressed the virtual cursor in
    // NVDA and JAWS, so a blind listener could not arrow through the
    // captions — which are the accessible transcript of an audio
    // medium. Asserting the landmarks alone proved nothing: the role
    // never removed them from the DOM, so that assertion stayed green
    // with the bug in place.
    await renderStory();

    const banner = screen.getByRole('banner');
    const root = banner.parentElement as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.getAttribute('role')).toBeNull();
    // And nothing else reintroduces it further up.
    expect(document.querySelector('[role="application"]')).toBeNull();

    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'A11y Story' })).toBeInTheDocument();
  });
});

describe('choice announcements', () => {
  it('announces the whole choice list on arriving at a passage', async () => {
    await renderStory();

    await waitFor(() => {
      expect(choiceStatusRegion()).toHaveTextContent(
        '3 choices: 1. Go left, 2. Go right, 3. Stay put',
      );
    });
  });

  it('announces the armed choice as it is cycled', async () => {
    await renderStory();
    await waitFor(() => expect(choiceStatusRegion()).toHaveTextContent(/3 choices/));

    fireEvent.keyDown(document.body, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(choiceStatusRegion()).toHaveTextContent('Choice 2 of 3: Go right');
    });

    fireEvent.keyDown(document.body, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(choiceStatusRegion()).toHaveTextContent('Choice 3 of 3: Stay put');
    });
  });

  it('announces choices even when the author hides the visible list', async () => {
    await renderStory({
      ...threeChoiceStory,
      settings: { showChoiceList: false },
    });

    // The list is clipped off-screen rather than removed...
    const nav = screen.getByRole('navigation', { name: 'Story choices' });
    expect(nav).toHaveStyle({ position: 'absolute', width: '1px', height: '1px' });
    // ...and the listener is told what is on offer without having to
    // find it.
    await waitFor(() => {
      expect(choiceStatusRegion()).toHaveTextContent(
        '3 choices: 1. Go left, 2. Go right, 3. Stay put',
      );
    });
  });

  it('says nothing about choices on a passage that has none', async () => {
    await renderStory();
    await waitFor(() => expect(choiceStatusRegion()).toHaveTextContent(/3 choices/));

    fireEvent.click(screen.getByLabelText('Choice 1: Go left'));

    await screen.findByText('You went left.');
    await waitFor(() =>
      expect(screen.getAllByRole('status').every((r) => !/choice/i.test(r.textContent ?? ''))).toBe(
        true,
      ),
    );
  });
});

describe('live-region registration', () => {
  /**
   * Screen readers announce MUTATIONS to a live region they have
   * already registered; text that is present the instant the region is
   * inserted is not announced. The story screen mounts <main> and both
   * regions in one commit, so an announcement written during that
   * render is silent — and the passage it silences is the opening one,
   * the only passage a listener has no other way to learn about.
   *
   * Assert the shape of the DOM change rather than its text: the
   * announcement must arrive as a mutation whose target is the region
   * itself, which can only happen if the region was already in the
   * document when the text landed.
   */
  async function announcementArrivedAsMutation(
    story: unknown,
    findRegion: () => HTMLElement,
    expected: RegExp,
  ): Promise<boolean> {
    (window as unknown as { __WANDERLINE_STORY__?: unknown }).__WANDERLINE_STORY__ = story;
    render(<App />);
    const startButton = await screen.findByLabelText('Start the story');

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((rs) => records.push(...rs));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    fireEvent.click(startButton);
    await waitFor(() => expect(findRegion()).toHaveTextContent(expected));

    records.push(...observer.takeRecords());
    observer.disconnect();

    const region = findRegion();
    return records.some(
      (r) =>
        r.target === region &&
        Array.from(r.addedNodes).some((n) => expected.test(n.textContent ?? '')),
    );
  }

  it('mounts the choice status region empty and announces into it', async () => {
    expect(
      await announcementArrivedAsMutation(threeChoiceStory, choiceStatusRegion, /3 choices/),
    ).toBe(true);
  });

  const narrationRegion = () => screen.getByRole('region', { name: 'Story narration' });

  it('mounts the captions-off passage line empty and announces into it', async () => {
    const captionsOff = { ...threeChoiceStory, settings: { captionsDefault: false } };
    expect(await announcementArrivedAsMutation(captionsOff, narrationRegion, /Now playing/)).toBe(
      true,
    );
  });

  it('re-registers the region after a trip through the Help screen', async () => {
    // Help puts the instructions screen back up, which unmounts <main>
    // and the live region with it. A flag that latched on first sight of
    // the story screen left the region re-inserted already populated on
    // the way back, so the passage returned to was silent.
    await renderStory();
    await screen.findByText('Welcome to the story.');

    fireEvent.click(screen.getByLabelText('Help and instructions'));
    const startAgain = await screen.findByLabelText('Start the story');

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((rs) => records.push(...rs));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    fireEvent.click(startAgain);
    const narration = await screen.findByRole('region', { name: 'Story narration' });
    await waitFor(() => expect(narration).toHaveTextContent('Welcome to the story.'));

    records.push(...observer.takeRecords());
    observer.disconnect();

    const announcedIntoRegisteredRegion = records.some(
      (r) =>
        r.target === narration &&
        Array.from(r.addedNodes).some((n) => /Welcome to the story/.test(n.textContent ?? '')),
    );
    expect(announcedIntoRegisteredRegion).toBe(true);
  });

  it('mounts the caption card empty and announces into it', async () => {
    // Captions on is the default, and the caption card used to be
    // inserted into the region already carrying the opening passage —
    // so the passage a listener has no other way to learn about was the
    // one thing never spoken.
    expect(
      await announcementArrivedAsMutation(
        threeChoiceStory,
        narrationRegion,
        /Welcome to the story/,
      ),
    ).toBe(true);
  });
});

describe('repeated announcements', () => {
  it('still fires when consecutive passages offer word-for-word identical choices', async () => {
    // React skips the update when a string is re-set to its current
    // value, so an identical announcement never mutated the region and
    // assistive tech said nothing on arrival.
    await renderStory(echoStory);
    await waitFor(() =>
      expect(choiceStatusRegion()).toHaveTextContent('2 choices: 1. Look around, 2. Go back'),
    );

    const region = choiceStatusRegion();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((rs) => records.push(...rs));
    observer.observe(region, { childList: true, subtree: true, characterData: true });

    fireEvent.click(screen.getByLabelText('Choice 1: Look around'));
    await screen.findByText('Room B.');

    records.push(...observer.takeRecords());
    observer.disconnect();

    expect(records.length).toBeGreaterThan(0);
    // Same wording, same region, and it changed anyway.
    expect(choiceStatusRegion()).toHaveTextContent('2 choices: 1. Look around, 2. Go back');
  });

  it('re-announces when a passage loops back to itself', async () => {
    // The node and the armed choice are both unchanged, so nothing the
    // announcement effects watched moved. The audio replays; without
    // this the listener got no words at all.
    await renderStory(loopStory);
    await waitFor(() =>
      expect(choiceStatusRegion()).toHaveTextContent('2 choices: 1. Circle again, 2. Leave'),
    );

    const region = choiceStatusRegion();
    const narration = screen.getByRole('region', { name: 'Story narration' });
    const choiceRecords: MutationRecord[] = [];
    const narrationRecords: MutationRecord[] = [];
    const choiceObserver = new MutationObserver((rs) => choiceRecords.push(...rs));
    const narrationObserver = new MutationObserver((rs) => narrationRecords.push(...rs));
    const opts = { childList: true, subtree: true, characterData: true };
    choiceObserver.observe(region, opts);
    narrationObserver.observe(narration, opts);

    fireEvent.click(screen.getByLabelText('Choice 1: Circle again'));

    // Both channels have to speak again: the passage text and the list
    // of ways out are word-for-word what they were a moment ago.
    await waitFor(() => {
      choiceRecords.push(...choiceObserver.takeRecords());
      narrationRecords.push(...narrationObserver.takeRecords());
      expect(choiceRecords.length).toBeGreaterThan(0);
      expect(narrationRecords.length).toBeGreaterThan(0);
    });
    choiceObserver.disconnect();
    narrationObserver.disconnect();

    expect(choiceStatusRegion()).toHaveTextContent('2 choices: 1. Circle again, 2. Leave');
    expect(narration).toHaveTextContent('You circle the room.');
  });

  it('still fires when consecutive passages read word-for-word the same, with captions on', async () => {
    // Captions on is the default, and the caption card is the live
    // region's content there. Two passages with identical prose used to
    // produce no DOM change at all.
    const sameProse = {
      ...echoStory,
      nodes: {
        ...echoStory.nodes,
        hubA: { ...echoStory.nodes.hubA, content: [{ text: 'The corridor again.' }] },
        hubB: { ...echoStory.nodes.hubB, content: [{ text: 'The corridor again.' }] },
      },
    };
    await renderStory(sameProse);
    const narration = screen.getByRole('region', { name: 'Story narration' });
    await waitFor(() => expect(narration).toHaveTextContent('The corridor again.'));

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((rs) => records.push(...rs));
    observer.observe(narration, { childList: true, subtree: true, characterData: true });

    fireEvent.click(screen.getByLabelText('Choice 1: Look around'));

    await waitFor(() => {
      records.push(...observer.takeRecords());
      expect(records.length).toBeGreaterThan(0);
    });
    observer.disconnect();

    expect(narration).toHaveTextContent('The corridor again.');
    // Exactly one insertion, not two: the caption card's text and its
    // key change in the same commit, so a screen reader is not given
    // two changes to speak for one passage.
    const insertedCards = records
      .flatMap((r) => Array.from(r.addedNodes))
      .filter((n) => (n as Element).tagName === 'ARTICLE');
    expect(insertedCards).toHaveLength(1);
  });

  it('announces the opening choice list under StrictMode', async () => {
    // StrictMode replays mount effects with refs intact. A marker that
    // only recorded the node id saw itself on the replay and downgraded
    // the arrival announcement to a selection one, so `npm run dev`
    // never read the opening list.
    (window as unknown as { __WANDERLINE_STORY__?: unknown }).__WANDERLINE_STORY__ =
      threeChoiceStory;
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    fireEvent.click(await screen.findByLabelText('Start the story'));

    await waitFor(() =>
      expect(choiceStatusRegion()).toHaveTextContent(
        '3 choices: 1. Go left, 2. Go right, 3. Stay put',
      ),
    );
  });
});

describe('choices when the author hides the visible list', () => {
  const hiddenListStory = { ...threeChoiceStory, settings: { showChoiceList: false } };

  it('keeps the choices operable rather than removing them', async () => {
    // Browse mode swallows the arrow keys before the global shortcuts
    // see them, so without real buttons a screen-reader user on one of
    // these stories has no way to pick anything.
    await renderStory(hiddenListStory);

    fireEvent.click(screen.getByLabelText('Choice 2: Go right'));

    expect(await screen.findByText('You went right.')).toBeInTheDocument();
  });

  it('reveals the list while it holds keyboard focus', async () => {
    await renderStory(hiddenListStory);

    const nav = screen.getByRole('navigation', { name: 'Story choices' });
    expect(nav).toHaveStyle({ position: 'absolute' });

    fireEvent.focus(screen.getByLabelText('Choice 1: Go left'));

    // A sighted keyboard user must be able to see where focus went.
    expect(nav).not.toHaveStyle({ position: 'absolute' });
  });

  it('stays revealed when focus survives the navigation', async () => {
    // Two passages offering the same option at the same index share a
    // React key, so the DOM button — and the focus on it — survives.
    // Resetting the reveal flag blindly left that focus sitting on an
    // element clipped to a single pixel.
    await renderStory({ ...stickyStory, settings: { showChoiceList: false } });

    // Real focus, not a synthetic event: this test turns on where
    // document.activeElement actually is after the navigation. Choice 1
    // on purpose — it is also the armed choice in the room we land in,
    // so nothing moves focus afterwards and nothing re-fires the focus
    // handler that would paper over the bug.
    screen.getByLabelText('Choice 1: Look').focus();
    const nav = screen.getByRole('navigation', { name: 'Story choices' });
    await waitFor(() => expect(nav).not.toHaveStyle({ position: 'absolute' }));

    // Navigate from the headphones, which leaves focus where it is.
    vi.advanceTimersByTime(200);
    fireEvent.keyDown(document.body, { key: 'MediaTrackPrevious', bubbles: true });
    await screen.findByText('Room two.');

    const navAfter = screen.getByRole('navigation', { name: 'Story choices' });
    expect(navAfter.contains(document.activeElement)).toBe(true);
    expect(navAfter).not.toHaveStyle({ position: 'absolute' });
  });

  it('hides it again once the chosen button is gone', async () => {
    // focusout does not fire when the focused element is REMOVED, and
    // choosing an option unmounts the button that had focus. Left to
    // the blur handler alone, the author's hidden list stayed on screen
    // for the rest of the session.
    await renderStory({ ...echoStory, settings: { showChoiceList: false } });

    const choice = screen.getByLabelText('Choice 1: Look around');
    fireEvent.focus(choice);
    expect(screen.getByRole('navigation', { name: 'Story choices' })).not.toHaveStyle({
      position: 'absolute',
    });

    fireEvent.click(choice);
    await screen.findByText('Room B.');

    expect(screen.getByRole('navigation', { name: 'Story choices' })).toHaveStyle({
      position: 'absolute',
    });
  });
});

describe('focus and the armed choice', () => {
  it('moves focus with the arrows once the list has focus', async () => {
    // A <button> does not claim the arrows, so they still reach the
    // global handler and move `selectedChoice`; Enter, which a button
    // does claim, activates whatever has focus. Left unsynced, a
    // listener who tabbed in and arrowed down twice heard "Choice 3 of
    // 3", saw aria-current on the third button, and activated the first.
    await renderStory();

    const first = screen.getByLabelText('Choice 1: Go left');
    first.focus();

    fireEvent.keyDown(first, { key: 'ArrowDown', bubbles: true });

    const second = screen.getByLabelText('Choice 2: Go right');
    await waitFor(() => expect(document.activeElement).toBe(second));
    expect(second).toHaveAttribute('aria-current', 'true');
  });

  it('arms the choice that receives focus', async () => {
    await renderStory();

    fireEvent.focus(screen.getByLabelText('Choice 3: Stay put'));

    await waitFor(() =>
      expect(screen.getByLabelText('Choice 3: Stay put')).toHaveAttribute('aria-current', 'true'),
    );
    expect(screen.getByLabelText('Choice 1: Go left')).not.toHaveAttribute('aria-current');
  });

  it('leaves focus alone when the list is cycled from a headphone button', async () => {
    // Cycling with the screen off must not start moving focus around.
    await renderStory();

    fireEvent.keyDown(document.body, { key: 'ArrowDown', bubbles: true });

    await waitFor(() =>
      expect(screen.getByLabelText('Choice 2: Go right')).toHaveAttribute('aria-current', 'true'),
    );
    expect(document.activeElement).toBe(document.body);
  });

  it('does not re-read the whole list when focus leaves it', async () => {
    // Standing the status down must not look like a fresh arrival on
    // the way out, or the entire list is read over whatever control the
    // listener has just tabbed to — every time they pass through.
    await renderStory();
    await waitFor(() => expect(choiceStatusRegion()).toHaveTextContent(/3 choices/));

    const first = screen.getByLabelText('Choice 1: Go left');
    fireEvent.focus(first);
    await waitFor(() =>
      expect(screen.getAllByRole('status').every((r) => !/choice/i.test(r.textContent ?? ''))).toBe(
        true,
      ),
    );

    const play = screen.getByRole('button', { name: /^(Play|Pause|Loading) / });
    fireEvent.blur(first, { relatedTarget: play });

    await waitFor(() =>
      expect(screen.getAllByRole('status').every((r) => !/choice/i.test(r.textContent ?? ''))).toBe(
        true,
      ),
    );
  });

  it('stands the spoken status down while the list has focus', async () => {
    // Assistive tech reads the focused button itself, so announcing the
    // same thing again is just noise.
    await renderStory();
    await waitFor(() => expect(choiceStatusRegion()).toHaveTextContent(/3 choices/));

    fireEvent.focus(screen.getByLabelText('Choice 1: Go left'));

    await waitFor(() =>
      expect(screen.getAllByRole('status').every((r) => !/choice/i.test(r.textContent ?? ''))).toBe(
        true,
      ),
    );
  });
});

describe('focus after choosing', () => {
  it('drops focus even when the same button is reused for a self-loop', async () => {
    // A knot that diverts to itself renders the identical choice at the
    // identical index, so React keeps the very same DOM button and the
    // key alone cannot help. Focus left on it turns the next Space,
    // meant to pause, into another lap of the room.
    await renderStory(loopStory);

    const choice = screen.getByLabelText('Choice 1: Circle again');
    choice.focus();
    expect(document.activeElement).toBe(choice);

    fireEvent.click(choice);

    // Keyboard-activated (detail 0): focus is handed to the story
    // region rather than dropped, so the next Tab does not restart from
    // the skip link at the top of the document.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('main')));
    expect(document.activeElement).not.toBe(choice);
  });

  it('leaves focus alone when the choice was clicked with a pointer', async () => {
    await renderStory(loopStory);

    const choice = screen.getByLabelText('Choice 1: Circle again');
    choice.focus();
    fireEvent.click(choice, { detail: 1 });

    // Moving focus under a mouse user is not wanted; dropping it is.
    await waitFor(() => expect(document.activeElement).toBe(document.body));
  });

  it('replaces the choice buttons so focus does not linger on a reused one', async () => {
    // Keyed by index, React reused the same DOM button across a
    // navigation: focus stayed on it while its meaning changed, so a
    // Space press meant to pause re-fired the button and jumped forward
    // again.
    await renderStory(echoStory);

    const firstChoice = screen.getByLabelText('Choice 1: Look around');
    firstChoice.focus();
    fireEvent.click(firstChoice);

    await screen.findByText('Room B.');

    expect(document.body.contains(firstChoice)).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});

describe('passage announcements with captions off', () => {
  it('announces the passage inside the live region when captions are off', async () => {
    await renderStory({
      ...threeChoiceStory,
      settings: { captionsDefault: false },
    });

    const narration = screen.getByRole('region', { name: 'Story narration' });
    // No visible caption card...
    expect(narration.querySelector('article')).toBeNull();
    // ...but the live region is not empty, so the passage change is
    // still spoken.
    await waitFor(() => expect(narration).toHaveTextContent('Now playing: Welcome to the story.'));
  });

  it('re-announces on the next passage with captions off', async () => {
    await renderStory({
      ...threeChoiceStory,
      settings: { captionsDefault: false },
    });

    fireEvent.click(screen.getByLabelText('Choice 2: Go right'));

    const narration = screen.getByRole('region', { name: 'Story narration' });
    await waitFor(() => expect(narration).toHaveTextContent('Now playing: You went right.'));
  });
});

describe('password screen', () => {
  const passwordStory = { ...threeChoiceStory, settings: { password: 'secret123' } };

  it('gives the password field an accessible name', async () => {
    (window as unknown as { __WANDERLINE_STORY__?: unknown }).__WANDERLINE_STORY__ = passwordStory;
    render(<App />);

    // A placeholder is not an accessible name; getByLabelText only
    // matches a real label / aria-label association.
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
  });

  it('announces a wrong password and marks the field invalid', async () => {
    (window as unknown as { __WANDERLINE_STORY__?: unknown }).__WANDERLINE_STORY__ = passwordStory;
    render(<App />);

    const input = await screen.findByLabelText('Password');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(input, { target: { value: 'wrong' } });
    const form = input.closest('form');
    if (form) fireEvent.submit(form);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Incorrect password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', alert.id);
  });
});

describe('settings disclosure', () => {
  it('is a disclosure rather than an unmanaged dialog', async () => {
    await renderStory();

    const cog = screen.getByLabelText('Settings');
    expect(cog).toHaveAttribute('aria-expanded', 'false');
    // aria-controls must not dangle while the panel is unrendered — an
    // IDREF pointing at an absent id is invalid and axe flags it.
    expect(cog).not.toHaveAttribute('aria-controls');

    fireEvent.click(cog);

    expect(cog).toHaveAttribute('aria-expanded', 'true');
    expect(cog).toHaveAttribute('aria-controls', 'settings-panel');
    expect(document.getElementById('settings-panel')).not.toBeNull();
    // role="dialog" without any focus management is worse than no
    // dialog semantics at all, and this panel is not modal.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
