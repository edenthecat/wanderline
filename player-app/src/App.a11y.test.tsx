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

  it('still cycles choices with the arrows while focus sits on a button', async () => {
    // The bail is per key, not per element. A <button> consumes only
    // Space and Enter, so the arrows must still reach the global
    // handler — on a story whose author hid the visible choice list
    // they are the only way to move the armed choice, and a listener
    // who just tapped Play has focus sitting on that button.
    await renderStory({ ...threeChoiceStory, settings: { showChoiceList: false } });

    const playButton = screen.getByRole('button', { name: /^(Play|Pause|Loading) / });
    const event = createEvent.keyDown(playButton, { key: 'ArrowDown', bubbles: true });
    fireEvent(playButton, event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(choiceStatusRegion()).toHaveTextContent('Choice 2 of 3: Go right'));
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

  it('still confirms on Enter while the auto-advance checkbox has focus', async () => {
    // A checkbox is toggled by Space and nothing else; Enter has no
    // meaning on it outside a form, so the global shortcut keeps it.
    await renderStory();
    fireEvent.click(screen.getByLabelText('Settings'));
    const checkbox = screen.getByRole('checkbox', { name: /advance automatically/i });

    expect(keyDownAndCheckCancelled(checkbox, 'Enter')).toBe(true);
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

  it('keeps the story landmarks and heading reachable', async () => {
    await renderStory();

    expect(screen.getByRole('banner')).toBeInTheDocument();
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

  it('mounts the captions-off passage line empty and announces into it', async () => {
    const captionsOff = { ...threeChoiceStory, settings: { captionsDefault: false } };
    const findLine = () => {
      const narration = screen.getByRole('region', { name: 'Story narration' });
      const p = narration.querySelector('p');
      if (!p) throw new Error('no passage announcement line found');
      return p as HTMLElement;
    };
    expect(await announcementArrivedAsMutation(captionsOff, findLine, /Now playing/)).toBe(true);
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
});

describe('focus after choosing', () => {
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
    expect(document.activeElement).toBe(document.body);
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
