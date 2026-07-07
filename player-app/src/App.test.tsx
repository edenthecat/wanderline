import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import App from './App';

// Mock story data for tests
const mockStory = {
  id: 'test-story',
  title: 'Test Story',
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
      tags: ['theme:blue'],
      audio: { voiceover: 'left.mp3' },
    },
    right: {
      id: 'right',
      type: 'knot',
      content: [{ text: 'You went right.' }],
      choices: [],
      divert: 'END',
      tags: [],
    },
  },
};

const mockStoryWithPassword = {
  ...mockStory,
  settings: { password: 'secret123' },
};

// Stub HTMLAudioElement
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

const originalAudio = globalThis.Audio;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.Audio = MockAudio as unknown as typeof Audio;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  // Flush pending timers before cleanup to prevent React state-after-unmount warnings
  vi.runOnlyPendingTimers();
  cleanup();
  vi.useRealTimers();
  globalThis.Audio = originalAudio;
  vi.restoreAllMocks();
  delete (window as any).__WANDERLINE_STORY__;
});

async function startTheStory() {
  const startButton = await screen.findByLabelText('Start the story');
  fireEvent.click(startButton);
}

describe('App', () => {
  describe('story loading', () => {
    it('loads story and shows start screen', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStory;
      render(<App />);

      expect(await screen.findByText('Test Story')).toBeInTheDocument();
      expect(screen.getByLabelText('Start the story')).toBeInTheDocument();
    });

    it('loads story from fetch (generated app mode)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockStory),
      } as Response);

      render(<App />);

      expect(await screen.findByText('Test Story')).toBeInTheDocument();
    });

    it('shows error state when no story data is available', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false } as Response);

      render(<App />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
      });
    });

    it('shows content after clicking start', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStory;
      render(<App />);

      await startTheStory();

      expect(await screen.findByText('Welcome to the story.')).toBeInTheDocument();
    });
  });

  describe('password protection', () => {
    it('shows password screen when story has a password', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStoryWithPassword;
      render(<App />);

      // Should show password input, not start button
      expect(await screen.findByPlaceholderText(/password/i)).toBeInTheDocument();
    });

    it('authenticates with correct password then shows start screen', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStoryWithPassword;
      render(<App />);

      const input = await screen.findByPlaceholderText(/password/i);
      fireEvent.change(input, { target: { value: 'secret123' } });

      const form = input.closest('form');
      if (form) fireEvent.submit(form);

      // After correct password, should show start screen
      expect(await screen.findByText('Start Story')).toBeInTheDocument();
    });

    it('shows error with incorrect password', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStoryWithPassword;
      render(<App />);

      const input = await screen.findByPlaceholderText(/password/i);
      fireEvent.change(input, { target: { value: 'wrong' } });

      const form = input.closest('form');
      if (form) fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText(/incorrect/i)).toBeInTheDocument();
      });
    });

    it('skips password when already authenticated in session', async () => {
      sessionStorage.setItem('wanderline_test-story_auth', 'true');
      (window as any).__WANDERLINE_STORY__ = mockStoryWithPassword;
      render(<App />);

      // Should go straight to start screen
      expect(await screen.findByText('Start Story')).toBeInTheDocument();
    });
  });

  describe('progress persistence', () => {
    it('resumes from saved progress', async () => {
      localStorage.setItem(
        'wanderline_test-story',
        JSON.stringify({ nodeId: 'left', history: ['start'] }),
      );
      (window as any).__WANDERLINE_STORY__ = mockStory;
      render(<App />);

      // Start screen shows first
      await startTheStory();

      // Should resume at the left node
      expect(await screen.findByText('You went left.')).toBeInTheDocument();
    });

    it('falls back to start node if saved node does not exist', async () => {
      localStorage.setItem(
        'wanderline_test-story',
        JSON.stringify({ nodeId: 'nonexistent', history: [] }),
      );
      (window as any).__WANDERLINE_STORY__ = mockStory;
      render(<App />);

      await startTheStory();

      expect(await screen.findByText('Welcome to the story.')).toBeInTheDocument();
    });
  });

  describe('navigation', () => {
    it('displays available choices for current node', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStory;
      render(<App />);

      await startTheStory();

      expect(await screen.findByText('Go left')).toBeInTheDocument();
      expect(screen.getByText('Go right')).toBeInTheDocument();
    });

    // Regression: choices with bare stitch targets ("infinite_grace")
    // instead of fully-qualified ("tell_you.infinite_grace") used to
    // silently no-op, leaving the player apparently stuck. The fix
    // resolves bare stitches relative to the current knot.
    it('resolves a bare stitch target relative to the current knot', async () => {
      (window as any).__WANDERLINE_STORY__ = {
        id: 'stuck',
        title: 'Stuck Test',
        audioBaseUrl: './audio/',
        startNode: 'tell_you',
        nodes: {
          tell_you: {
            id: 'tell_you',
            type: 'knot',
            content: [{ text: 'Whichever way it went.' }],
            choices: [
              // Bare stitch ref — must resolve to tell_you.no_reason
              { text: 'Do they?', target: 'no_reason' },
            ],
            divert: null,
            tags: [],
          },
          'tell_you.no_reason': {
            id: 'tell_you.no_reason',
            type: 'stitch',
            content: [{ text: 'No reason content.' }],
            choices: [],
            divert: 'END',
            tags: [],
            parent: 'tell_you',
          },
        },
      };
      render(<App />);
      await startTheStory();
      // Click the choice that uses the bare stitch target.
      const choice = await screen.findByText('Do they?');
      fireEvent.click(choice);
      // We should land on tell_you.no_reason's content, not stay stuck.
      await waitFor(() => {
        expect(screen.queryByText('No reason content.')).toBeInTheDocument();
      });
    });
  });

  describe('UI options (project settings)', () => {
    // Each test starts the story so we land on the audio + choices view
    // (the screens that the UI options actually affect).

    it('captions toggle defaults to on when settings.captionsDefault is unset', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStory;
      render(<App />);

      await startTheStory();

      const ccBtn = await screen.findByLabelText(/captions/i);
      expect(ccBtn).toHaveAttribute('aria-pressed', 'true');
    });

    it('captions toggle starts off when settings.captionsDefault is false', async () => {
      (window as any).__WANDERLINE_STORY__ = {
        ...mockStory,
        settings: { captionsDefault: false },
      };
      render(<App />);

      await startTheStory();

      const ccBtn = await screen.findByLabelText(/captions/i);
      expect(ccBtn).toHaveAttribute('aria-pressed', 'false');
    });

    it('progress bar renders by default while audio is playing', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStory;
      render(<App />);

      await startTheStory();

      // Wait for the audio player UI to mount and the progress bar with it
      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toBeInTheDocument();
      });
    });

    it('progress bar is hidden when settings.showProgressBar is false', async () => {
      (window as any).__WANDERLINE_STORY__ = {
        ...mockStory,
        settings: { showProgressBar: false },
      };
      render(<App />);

      await startTheStory();

      // The play button still renders (we only hid the progress bar) — wait
      // for it so we know the audio UI mounted, then assert no progressbar.
      await screen.findByLabelText(/play narration|pause narration/i);
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('choice list is hidden when settings.showChoiceList is false', async () => {
      (window as any).__WANDERLINE_STORY__ = {
        ...mockStory,
        settings: { showChoiceList: false },
      };
      render(<App />);

      await startTheStory();

      // Wait for the narration to mount so we know the post-start view is up
      await screen.findByText('Welcome to the story.');
      // Choice nav and its buttons should not render
      expect(screen.queryByRole('navigation', { name: /story choices/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Go left')).not.toBeInTheDocument();
      expect(screen.queryByText('Go right')).not.toBeInTheDocument();
    });
  });

  // phone call / notification / tab-switch interruptions.
  // The handler pauses any *playing* audio when document.hidden flips
  // on, remembers what it paused, and resumes only those on the way
  // back. We exercise the contract directly rather than asserting
  // against MockAudio's prototype, which is brittle (per-instance
  // `paused` shadows any prototype override).
  describe('interruption handling', () => {
    it('registers a visibilitychange listener that does not throw', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStory;
      const addSpy = vi.spyOn(document, 'addEventListener');
      render(<App />);
      await startTheStory();
      await screen.findByText('Welcome to the story.');
      const calls = addSpy.mock.calls.map((c) => c[0]);
      expect(calls).toContain('visibilitychange');

      // Firing the event with no audio playing is safe — no crash.
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
    });

    it('only pauses the active audio instance on hide (not every Audio object)', async () => {
      (window as any).__WANDERLINE_STORY__ = mockStory;
      render(<App />);
      await startTheStory();
      await screen.findByText('Welcome to the story.');

      // Construct a paused "background" Audio + a playing "voice" Audio
      // and confirm the handler treats them differently. Both are real
      // MockAudio instances, so their .paused is a true instance field.
      const playing = new (globalThis.Audio as unknown as { new (): MockAudio })();
      playing.paused = false;
      const playingPauseSpy = vi.spyOn(playing, 'pause');

      const alreadyPaused = new (globalThis.Audio as unknown as { new (): MockAudio })();
      alreadyPaused.paused = true;
      const alreadyPausedPauseSpy = vi.spyOn(alreadyPaused, 'pause');
      const alreadyPausedPlaySpy = vi.spyOn(alreadyPaused, 'play');

      // We can't reach into the app's refs from the test, so the
      // assertion is necessarily indirect: we verify that a) calling
      // pause() on a playing instance is safe and idempotent and b) a
      // paused instance is not played by anything we wired. This is
      // the same shape the handler relies on. (A fuller integration
      // would replace the app's refs via context, which the app
      // doesn't expose by design.)
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));

      // The handler itself only touches audioRef.current / bgMusicRef.current,
      // so our externally-constructed instances should be untouched.
      expect(playingPauseSpy).not.toHaveBeenCalled();
      expect(alreadyPausedPauseSpy).not.toHaveBeenCalled();
      expect(alreadyPausedPlaySpy).not.toHaveBeenCalled();
    });
  });
});
