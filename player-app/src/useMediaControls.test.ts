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
  navigateToNode: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  onHeadphoneButtonPress: ReturnType<typeof vi.fn>;
}

function harnessHooks(overrides: Partial<Parameters<typeof useMediaControls>[0]> = {}) {
  const spies: HandlerRefs = {
    navigateToTarget: vi.fn(),
    navigateToNode: vi.fn(),
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
    const navigateToNodeRef = useRef<((n: string) => void) | null>(
      spies.navigateToNode as unknown as (n: string) => void,
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
        navigateToNodeRef,
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
      navigateToNode: vi.fn(),
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
        const navigateToNodeRef = useRef<((n: string) => void) | null>(
          spies.navigateToNode as unknown as (n: string) => void,
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
            navigateToNodeRef,
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
