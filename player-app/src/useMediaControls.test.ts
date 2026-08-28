import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaControls } from './useMediaControls';

// smoke coverage for the extracted MediaSession +
// keydown-fallback bundle. The hook is heavy on side effects
// (window.addEventListener, navigator.mediaSession.*) — tests focus
// on the invariants that would silently break in a refactor:
//   1. Live MediaSession handlers get installed when the story is
//      running and cleared on teardown.
//   2. The keydown fallback resolves 'MediaPlayPause' /
//      'MediaTrackNext' etc. to the current handlers.
//   3. Instructions-screen keydown starts the story via startStory.

interface HandlerRefs {
  navigateToTarget: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  onHeadphoneButtonPress: ReturnType<typeof vi.fn>;
}

function harnessHooks(overrides: Partial<Parameters<typeof useMediaControls>[0]> = {}) {
  const spies: HandlerRefs = {
    navigateToTarget: vi.fn(),
    goBack: vi.fn(),
    onHeadphoneButtonPress: vi.fn(),
  };
  const startStory = vi.fn();
  const setSelectedChoice = vi.fn();

  const { result } = renderHook(() => {
    // vi.fn() returns a generic Mock; cast to the specific signature
    // each ref carries so TSC accepts the initial value.
    const navigateToTargetRef = useRef<((t: string) => void) | null>(
      spies.navigateToTarget as unknown as (t: string) => void,
    );
    const goBackRef = useRef<(() => void) | null>(spies.goBack as unknown as () => void);
    const onHeadphoneButtonPressRef = useRef<(() => void) | null>(
      spies.onHeadphoneButtonPress as unknown as () => void,
    );
    const currentNodeRef = useRef(overrides.currentNode ?? null);
    const selectedChoiceRef = useRef(0);
    return useMediaControls({
      story: null,
      currentNode: null,
      showInstructions: false,
      isAuthenticated: false,
      playerState: 'loading',
      startStory,
      handlers: {
        navigateToTargetRef,
        goBackRef,
        onHeadphoneButtonPressRef,
      },
      currentNodeRef,
      selectedChoiceRef,
      setSelectedChoice,
      ...overrides,
    });
  });
  return { result, spies, startStory, setSelectedChoice };
}

// Track MediaSession bindings so we can assert on them without
// relying on the jsdom stub's implementation.
const mediaSessionHandlers = new Map<string, MediaSessionActionHandler | null>();
// Per-action call count — a rebinding regression would show up as
// this count growing on every parent re-render.
const setActionHandlerCalls = new Map<string, number>();

// Attach a fake `mediaSession` directly to the real jsdom navigator
// (which doesn't ship one). Using `Object.defineProperty` instead of
// `vi.stubGlobal('navigator', …)` because the latter would clear the
// MediaMetadata / matchMedia globals the file-level test-setup.ts
// stubs — those are needed by the hook we're testing.
const fakeMediaSession = {
  metadata: null as MediaMetadata | null,
  playbackState: 'none' as MediaSessionPlaybackState,
  setActionHandler: (action: string, handler: MediaSessionActionHandler | null) => {
    mediaSessionHandlers.set(action, handler);
    setActionHandlerCalls.set(action, (setActionHandlerCalls.get(action) ?? 0) + 1);
  },
};

beforeEach(() => {
  mediaSessionHandlers.clear();
  setActionHandlerCalls.clear();
  fakeMediaSession.metadata = null;
  fakeMediaSession.playbackState = 'none';
  Object.defineProperty(navigator, 'mediaSession', {
    value: fakeMediaSession,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  // Remove the property so subsequent tests / files see the vanilla
  // jsdom navigator (which doesn't have mediaSession).
  // @ts-expect-error -- deliberate cleanup of a stubbed-on property.
  delete navigator.mediaSession;
});

const runningStory = {
  id: 'story-1',
  title: 'Test',
  nodes: {
    home: { choices: [{ target: 'kitchen' }], divert: null },
    kitchen: { choices: [], divert: null },
  },
  settings: {},
};

describe('useMediaControls — MediaSession bindings', () => {
  it('installs the running-state handlers when a story is playing', () => {
    harnessHooks({
      story: runningStory,
      currentNode: { id: 'home', content: [{ text: 'Hi.' }], choices: [], divert: null },
      showInstructions: false,
      isAuthenticated: true,
      playerState: 'playing',
    });
    expect(typeof mediaSessionHandlers.get('play')).toBe('function');
    expect(typeof mediaSessionHandlers.get('nexttrack')).toBe('function');
    expect(typeof mediaSessionHandlers.get('previoustrack')).toBe('function');
    expect(typeof mediaSessionHandlers.get('seekforward')).toBe('function');
  });

  it('mirrors playerState onto navigator.mediaSession.playbackState', () => {
    harnessHooks({
      story: runningStory,
      currentNode: { id: 'home', content: [{ text: 'Hi.' }], choices: [], divert: null },
      showInstructions: false,
      isAuthenticated: true,
      playerState: 'paused',
    });
    expect(navigator.mediaSession.playbackState).toBe('paused');
  });

  it('installs instructions-screen handlers that all invoke startStory', () => {
    const { startStory } = harnessHooks({
      story: runningStory,
      showInstructions: true,
      isAuthenticated: false,
      playerState: 'ready',
    });
    // Every transport press on the instructions screen kicks off the story.
    const play = mediaSessionHandlers.get('play');
    const next = mediaSessionHandlers.get('nexttrack');
    act(() => {
      play?.({ action: 'play' } as MediaSessionActionDetails);
      next?.({ action: 'nexttrack' } as MediaSessionActionDetails);
    });
    expect(startStory).toHaveBeenCalledTimes(2);
  });
});

describe('useMediaControls — keydown fallback', () => {
  it('MediaPlayPause invokes the headphone-button handler when the story is authenticated + running', () => {
    const { spies } = harnessHooks({
      story: runningStory,
      currentNode: { id: 'home', content: [{ text: 'Hi.' }], choices: [], divert: null },
      showInstructions: false,
      isAuthenticated: true,
      playerState: 'playing',
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'MediaPlayPause' }));
    });
    expect(spies.onHeadphoneButtonPress).toHaveBeenCalledTimes(1);
  });

  it('MediaTrackNext navigates to choices[0] under the default choice1 mapping', () => {
    const { spies } = harnessHooks({
      story: runningStory,
      currentNode: {
        id: 'home',
        content: [{ text: 'Hi.' }],
        choices: [{ target: 'kitchen' }],
        divert: null,
      },
      showInstructions: false,
      isAuthenticated: true,
      playerState: 'playing',
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'MediaTrackNext' }));
    });
    expect(spies.navigateToTarget).toHaveBeenCalledWith('kitchen');
  });

  it('MediaPlayPause on the instructions screen starts the story regardless of auth state', () => {
    const { startStory } = harnessHooks({
      story: runningStory,
      showInstructions: true,
      isAuthenticated: false,
      playerState: 'ready',
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'MediaPlayPause' }));
    });
    expect(startStory).toHaveBeenCalledTimes(1);
  });

  it('does nothing for non-media KeyboardEvents', () => {
    const { spies, startStory } = harnessHooks({
      story: runningStory,
      currentNode: { id: 'home', content: [{ text: 'Hi.' }], choices: [], divert: null },
      showInstructions: false,
      isAuthenticated: true,
      playerState: 'playing',
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(spies.onHeadphoneButtonPress).not.toHaveBeenCalled();
    expect(startStory).not.toHaveBeenCalled();
  });

  it('does not rebind MediaSession handlers on unrelated parent re-renders', () => {
    // Regression: `handlers` used to be a plain object literal in
    // deps, so every parent render re-memoized `mediaActions` and
    // tore down + rebound the transport handlers. On iOS Safari the
    // brief window between unbind and rebind can drop a Bluetooth
    // event entirely. Refs from useRef have stable identity, so
    // the memo deps hold the refs directly and rebinding is anchored
    // to actual state changes.
    const spies: HandlerRefs = {
      navigateToTarget: vi.fn(),
      goBack: vi.fn(),
      onHeadphoneButtonPress: vi.fn(),
    };
    const startStory = vi.fn();
    const setSelectedChoice = vi.fn();

    const initialProps = { unused: 0 };
    const { rerender } = renderHook(
      (_props: { unused: number }) => {
        const navigateToTargetRef = useRef<((t: string) => void) | null>(
          spies.navigateToTarget as unknown as (t: string) => void,
        );
        const goBackRef = useRef<(() => void) | null>(spies.goBack as unknown as () => void);
        const onHeadphoneButtonPressRef = useRef<(() => void) | null>(
          spies.onHeadphoneButtonPress as unknown as () => void,
        );
        const currentNodeRef = useRef({
          id: 'home',
          content: [{ text: 'Hi.' }],
          choices: [],
          divert: null,
        });
        const selectedChoiceRef = useRef(0);
        return useMediaControls({
          story: runningStory,
          currentNode: {
            id: 'home',
            content: [{ text: 'Hi.' }],
            choices: [],
            divert: null,
          },
          showInstructions: false,
          isAuthenticated: true,
          playerState: 'playing',
          startStory,
          // NEW object literal every render — this is what App.tsx
          // does at the call site. Pre-fix, this would cascade
          // through the memo deps.
          handlers: {
            navigateToTargetRef,
            goBackRef,
            onHeadphoneButtonPressRef,
          },
          currentNodeRef,
          selectedChoiceRef,
          setSelectedChoice,
        });
      },
      { initialProps },
    );

    const initialCallCount = setActionHandlerCalls.get('play') ?? 0;
    // Force three unrelated parent re-renders.
    rerender({ unused: 1 });
    rerender({ unused: 2 });
    rerender({ unused: 3 });
    const finalCallCount = setActionHandlerCalls.get('play') ?? 0;
    // Baseline is 1 (initial mount installs the handler). No
    // additional installs should have fired.
    expect(finalCallCount).toBe(initialCallCount);
  });

  it('drops auto-repeat keydown events so a sticky button does not fire multiple transports', () => {
    const { spies } = harnessHooks({
      story: runningStory,
      currentNode: { id: 'home', content: [{ text: 'Hi.' }], choices: [], divert: null },
      showInstructions: false,
      isAuthenticated: true,
      playerState: 'playing',
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'MediaPlayPause', repeat: true }));
    });
    expect(spies.onHeadphoneButtonPress).not.toHaveBeenCalled();
  });
});

// Coverage for three transport faults reported against Bluetooth
// headphones, where the only symptom available to a listener is
// "nothing happened".
describe('useMediaControls — Bluetooth transport faults', () => {
  const twoChoiceNode = {
    id: 'home',
    content: [{ text: 'Hi.' }],
    choices: [{ target: 'kitchen' }, { target: 'garden' }],
    divert: null,
  };
  const linearNode = {
    id: 'hall',
    content: [{ text: 'A corridor.' }],
    choices: [],
    divert: null,
  };

  function running(overrides: Record<string, unknown> = {}) {
    return harnessHooks({
      story: runningStory,
      currentNode: twoChoiceNode,
      showInstructions: false,
      isAuthenticated: true,
      playerState: 'playing',
      ...overrides,
    });
  }

  // The media session used to report 'none' for four of the six player
  // states — including 'ended', which is where the player sits for the
  // whole choice-prompt phase. 'none' tells the OS there is no session,
  // so it stops routing next/previous to the headset and only play/pause
  // survives. That is the entire reported symptom.
  describe('the media session stays live while a story is loaded', () => {
    it.each([
      ['playing', 'playing'],
      ['ended', 'playing'],
      ['paused', 'paused'],
      ['loading', 'paused'],
      ['ready', 'paused'],
      ['error', 'paused'],
    ])('maps playerState %p to playbackState %p', (playerState, expected) => {
      running({ playerState });
      expect(navigator.mediaSession.playbackState).toBe(expected);
    });

    it('reports none only when there is genuinely no story', () => {
      harnessHooks({ story: null, playerState: 'loading' });
      expect(navigator.mediaSession.playbackState).toBe('none');
    });
  });

  // A single 75ms timestamp shared by every transport meant two
  // different actions arriving together lost one of them: a gesture
  // emitting play+nexttrack had whichever landed first win, so pressing
  // skip toggled play/pause instead.
  describe('transports dedupe independently of one another', () => {
    it('lets a different action through inside the dedupe window', () => {
      const { spies } = running();
      act(() => {
        mediaSessionHandlers.get('play')?.({} as MediaSessionActionDetails);
        mediaSessionHandlers.get('nexttrack')?.({} as MediaSessionActionDetails);
      });
      expect(spies.onHeadphoneButtonPress).toHaveBeenCalledTimes(1);
      expect(spies.navigateToTarget).toHaveBeenCalledWith('kitchen');
    });

    // The original reason the dedupe exists: macOS Chrome fires BOTH a
    // MediaSession action and a keydown for one media-key press. That
    // must still collapse to a single navigation.
    it('still collapses one press arriving on both transports', () => {
      const { spies } = running();
      act(() => {
        mediaSessionHandlers.get('nexttrack')?.({} as MediaSessionActionDetails);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'MediaTrackNext' }));
      });
      expect(spies.navigateToTarget).toHaveBeenCalledTimes(1);
    });

    it('still collapses a repeated play/pause', () => {
      const { spies } = running();
      act(() => {
        mediaSessionHandlers.get('play')?.({} as MediaSessionActionDetails);
        mediaSessionHandlers.get('pause')?.({} as MediaSessionActionDetails);
      });
      expect(spies.onHeadphoneButtonPress).toHaveBeenCalledTimes(1);
    });
  });

  // 'choice2' required two choices and had no fallback, so the
  // previous-track button was inert on every linear node — and on every
  // node during narration, since choices aren't offered until the
  // passage ends.
  describe('previous-track does something on every node', () => {
    it('selects the second choice when there is one', () => {
      const { spies } = running();
      act(() => {
        mediaSessionHandlers.get('previoustrack')?.({} as MediaSessionActionDetails);
      });
      expect(spies.navigateToTarget).toHaveBeenCalledWith('garden');
      expect(spies.goBack).not.toHaveBeenCalled();
    });

    it('falls back to going back on a node with no second choice', () => {
      const { spies } = running({ currentNode: linearNode });
      act(() => {
        mediaSessionHandlers.get('previoustrack')?.({} as MediaSessionActionDetails);
      });
      expect(spies.goBack).toHaveBeenCalledTimes(1);
    });

    it('honours an explicit go_back mapping unchanged', () => {
      const { spies } = running({
        story: { ...runningStory, settings: { bluetoothControls: { previousTrack: 'go_back' } } },
      });
      act(() => {
        mediaSessionHandlers.get('previoustrack')?.({} as MediaSessionActionDetails);
      });
      expect(spies.goBack).toHaveBeenCalledTimes(1);
      expect(spies.navigateToTarget).not.toHaveBeenCalled();
    });
  });

  // A divert written as a bare stitch name is the common shape out of
  // the Ink compiler. The transports used to demand an exact node id
  // and route through navigateToNode, so such a passage advanced from
  // the keyboard and from auto-advance but did nothing at all on a
  // Bluetooth remote — the primary interface for this player.
  describe('following a bare-stitch divert from the transports', () => {
    const bareDivertNode = {
      id: 'tell_you.hallway',
      content: [{ text: 'A hallway.' }],
      choices: [],
      divert: 'ending',
    };

    it('hands the raw reference to the resolver on next-track', () => {
      const { spies } = running({
        currentNode: bareDivertNode,
        story: {
          ...runningStory,
          nodes: { 'tell_you.hallway': { choices: [], divert: 'ending' } },
          settings: { bluetoothControls: { nextTrack: 'divert' } },
        },
      });
      act(() => {
        mediaSessionHandlers.get('nexttrack')?.({} as MediaSessionActionDetails);
      });
      expect(spies.navigateToTarget).toHaveBeenCalledWith('ending');
    });

    it('hands the raw reference to the resolver on seek-forward', () => {
      const { spies } = running({
        currentNode: bareDivertNode,
        story: {
          ...runningStory,
          nodes: { 'tell_you.hallway': { choices: [], divert: 'ending' } },
        },
      });
      act(() => {
        mediaSessionHandlers.get('seekforward')?.({} as MediaSessionActionDetails);
      });
      expect(spies.navigateToTarget).toHaveBeenCalledWith('ending');
    });
  });
});
