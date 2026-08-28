import { fallThroughTarget } from './fall-through';
import { isFromTextEntry } from './keyboard-target';
// extract MediaSession + keydown fallback from App.tsx.
//
// The bundle we lift here:
//   1. Instructions-screen MediaSession binding — any transport press
//      (play/pause/next/prev) starts the story.
//   2. `mediaActions` — the play-pause / next / previous / seek closures
//      that the bluetooth-mapping settings resolve into. Guarded by a
//      75ms dedupe window (mediaTransportLastFiredAtRef) because macOS
//      Chrome fires BOTH the MediaSession action handler AND a window
//      keydown for the same OS-level media-key press.
//   3. Live MediaSession bus binding — install those closures on the
//      real navigator.mediaSession while the story is running.
//   4. Keep keyboard-fallback refs (handleMediaNext/PreviousRef)
//      current with the latest closures.
//   5. fallback keydown listener — some wired IEMs surface
//      inline-button presses as `KeyboardEvent`s (event.key values like
//      'MediaPlayPause' / 'MediaTrackNext') instead of via
//      navigator.mediaSession. Bind a separate window listener that
//      mirrors the MediaSession action handlers so these presses still
//      drive the player.
//   6. MediaSession metadata refresh as the current node changes.
//   7. MediaSession playbackState mirror.
//
// The hook owns the dedupe ref and the media-key sets internally so
// callers don't have to plumb them.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type React from 'react';

// The set of KeyboardEvent.key values that browsers emit for media
// controls. Includes both spec-correct ('MediaPlayPause',
// 'MediaTrackNext') and the alternate older spellings some Chromium
// builds and Android keyboards still emit. Module-level Set so the
// hot keydown handler does a single O(1) lookup per press.
const MEDIA_KEYS_PLAY_PAUSE = new Set<string>(['MediaPlayPause', 'MediaPlay', 'MediaPause']);
const MEDIA_KEYS_NEXT = new Set<string>(['MediaTrackNext', 'MediaNextTrack']);
const MEDIA_KEYS_PREVIOUS = new Set<string>(['MediaTrackPrevious', 'MediaPreviousTrack']);

// macOS Chrome and some Windows builds fire BOTH a
// MediaSession action handler AND a window keydown for the same
// OS-level media-key press. Both transports stamp the same key
// before invoking their handler and bail if a sibling stamp landed
// within this window.
//
// Stamped PER ACTION, not globally. A single shared timestamp also
// swallowed genuinely different actions that arrived together: a
// Bluetooth gesture emitting `play` and `nexttrack` a few ms apart had
// whichever landed first win, and the other was discarded in silence.
// The listener pressed skip and got play/pause. Keying by action keeps
// the same-press-two-transports case deduped — that press produces the
// same action on both paths — while letting a real pair through.
const MEDIA_TRANSPORT_DEDUPE_MS = 75;

/** Logical transports that dedupe independently of one another. */
type TransportKey = 'playpause' | 'next' | 'previous' | 'seekforward' | 'seekbackward';

type BluetoothAction = 'choice1' | 'choice2' | 'cycle_choices' | 'confirm' | 'divert' | 'go_back';

interface BluetoothControls {
  nextTrack?: BluetoothAction;
  previousTrack?: BluetoothAction;
}

interface StoryLike {
  id?: string;
  title: string;
  nodes: Record<
    string,
    {
      type?: string;
      parent?: string | null;
      lineNumber?: number;
      choices: { target: string }[];
      divert?: string | null;
    }
  >;
  settings?: { bluetoothControls?: BluetoothControls };
}

interface NodeLike {
  id: string;
  type?: string;
  parent?: string | null;
  content: { text: string }[];
  choices: { target: string }[];
  divert?: string | null;
  metadata?: { transcript?: string | null };
}

type PlayerState = 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

/**
 * The single way onward from a passage, including Ink's implicit
 * continuation. Transports used to follow only `divert`, so on a
 * fall-through passage the on-screen Continue worked while every
 * headphone button did nothing — with the screen off, that leaves a
 * listener stuck with no way to find out why.
 */
function onwardFrom(node: NodeLike, story: StoryLike): string | null {
  const target = node.divert ?? fallThroughTarget(node.id, node, story.nodes);
  return target && story.nodes[target] ? target : null;
}

export interface MediaActions {
  handlePlayPause: () => void;
  handleNext: () => void;
  handlePrevious: () => void;
  handleSeekForward: () => void;
  handleSeekBackward: () => void;
}

export interface UseMediaControlsArgs {
  story: StoryLike | null;
  currentNode: NodeLike | null;
  showInstructions: boolean;
  isAuthenticated: boolean;
  playerState: PlayerState;
  /** Stable callback for "start the story from the instructions
   * screen". Called by both the instructions MediaSession binding
   * and the keydown-fallback path when it fires on the instructions
   * screen. Kept as a plain callback (not a ref) because it's a
   * `useCallback` in App and used directly by the effect. */
  startStory: () => void;
  /** Set of always-latest callback refs the hook reads to avoid
   * re-binding effects on every state change (which on iOS Safari
   * can drop Bluetooth events during the unbind/rebind window). */
  handlers: {
    navigateToTargetRef: React.MutableRefObject<((target: string) => void) | null>;
    navigateToNodeRef: React.MutableRefObject<((nodeId: string) => void) | null>;
    goBackRef: React.MutableRefObject<(() => void) | null>;
    onHeadphoneButtonPressRef: React.MutableRefObject<(() => void) | null>;
  };
  /** Current node exposed via a ref so the media-action closures see
   * the latest value even between the binding effect's re-runs. */
  currentNodeRef: React.MutableRefObject<NodeLike | null>;
  /** Latest selected-choice index for the `cycle_choices` /
   * `confirm` actions. Exposed via a ref so rapid headphone presses
   * see the latest value, not the closure-captured snapshot. */
  selectedChoiceRef: React.MutableRefObject<number>;
  /** Setter for the `cycle_choices` action. Passed as a function so
   * the hook can call `(c) => Math.min(...)` without owning the
   * state itself. */
  setSelectedChoice: React.Dispatch<React.SetStateAction<number>>;
}

export interface UseMediaControlsResult {
  /** The play-pause / next / previous closures the keydown
   * fallback and the MediaSession bus both invoke. Exposed so App
   * can also mirror them onto its own refs if needed. */
  mediaActions: MediaActions | null;
}

/**
 * Bind MediaSession action handlers + a keydown fallback for wired
 * in-ear-monitor headsets. Returns the resolved media-action closures
 * so callers can wire their own transport code (drag handles, on-screen
 * buttons) through the same dedupe path.
 */
export function useMediaControls(args: UseMediaControlsArgs): UseMediaControlsResult {
  const {
    story,
    currentNode,
    showInstructions,
    isAuthenticated,
    playerState,
    startStory,
    handlers,
    currentNodeRef,
    selectedChoiceRef,
    setSelectedChoice,
  } = args;

  // Destructure the ref bag ONCE at the hook boundary. `handlers` is a
  // fresh object literal at the App call site every render, so passing
  // it directly into the useMemo/useEffect deps would re-memoize
  // `mediaActions` and tear down + rebind the MediaSession + keydown
  // listeners on every render — exactly the iOS Safari Bluetooth-drop
  // window this hook is engineered to avoid. The refs themselves have
  // stable identity across renders, so pinning the deps to them keeps
  // the bindings anchored to real state changes.
  const { navigateToTargetRef, navigateToNodeRef, goBackRef, onHeadphoneButtonPressRef } = handlers;

  const mediaTransportLastFiredAtRef = useRef<Partial<Record<TransportKey, number>>>({});
  const handleMediaNextRef = useRef<(() => void) | null>(null);
  const handleMediaPreviousRef = useRef<(() => void) | null>(null);
  const startStoryRef = useRef<() => void>(startStory);
  useEffect(() => {
    startStoryRef.current = startStory;
  }, [startStory]);

  // 1. Instructions-screen MediaSession binding — any transport press
  // starts the story. Capture `navigator.mediaSession` up front so
  // the cleanup closure has a stable reference — otherwise a
  // browser (or a jsdom test tear-down) that swaps navigator between
  // setup and cleanup would crash on `navigator.mediaSession.foo`.
  useEffect(() => {
    if (!story || !showInstructions) return;
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.metadata = new MediaMetadata({
      title: 'Press play to start',
      artist: story.title,
      album: 'Wanderline Story',
    });
    ms.setActionHandler('play', startStory);
    ms.setActionHandler('pause', startStory);
    ms.setActionHandler('nexttrack', startStory);
    ms.setActionHandler('previoustrack', startStory);
    return () => {
      ms.setActionHandler('play', null);
      ms.setActionHandler('pause', null);
      ms.setActionHandler('nexttrack', null);
      ms.setActionHandler('previoustrack', null);
    };
  }, [story, showInstructions, startStory]);

  const claimFire = useCallback((key: TransportKey): boolean => {
    const now = performance.now();
    const last = mediaTransportLastFiredAtRef.current[key] ?? 0;
    if (now - last < MEDIA_TRANSPORT_DEDUPE_MS) return false;
    mediaTransportLastFiredAtRef.current[key] = now;
    return true;
  }, []);

  // 2. Build the play-pause / next / previous closures. Re-created
  // when the underlying bluetooth-mapping settings change; otherwise
  // stable across parent re-renders.
  const mediaActions = useMemo<MediaActions | null>(() => {
    if (!story || showInstructions) return null;

    const nextAction: BluetoothAction = story.settings?.bluetoothControls?.nextTrack ?? 'choice1';
    const prevAction: BluetoothAction =
      story.settings?.bluetoothControls?.previousTrack ?? 'choice2';

    const handlePlayPause = () => {
      if (!claimFire('playpause')) return;
      onHeadphoneButtonPressRef.current?.();
    };

    const handleNext = () => {
      if (!claimFire('next')) return;
      const node = currentNodeRef.current;
      if (!node) return;
      const navigateToTarget = navigateToTargetRef.current;
      const navigateToNode = navigateToNodeRef.current;
      if (!navigateToTarget || !navigateToNode) return;
      switch (nextAction) {
        case 'choice1': {
          const choice = node.choices[0];
          if (choice) navigateToTarget(choice.target);
          else if (onwardFrom(node, story)) navigateToNode(onwardFrom(node, story)!);
          break;
        }
        case 'cycle_choices':
          if (node.choices.length > 0) {
            setSelectedChoice((c) => Math.min(node.choices.length - 1, c + 1));
          }
          break;
        case 'confirm': {
          // Read selection through the ref so rapid headphone presses
          // see the latest value, not the closure-captured snapshot.
          const choice = node.choices[selectedChoiceRef.current];
          if (choice) navigateToTarget(choice.target);
          else if (onwardFrom(node, story)) navigateToNode(onwardFrom(node, story)!);
          break;
        }
        case 'divert':
          if (onwardFrom(node, story)) navigateToNode(onwardFrom(node, story)!);
          break;
        default:
          // Unknown action (likely a typo in project_settings JSONB).
          // Warn so authors can debug instead of silently no-op'ing.
          console.warn('[wanderline] Unknown bluetooth nextTrack action:', nextAction);
      }
    };

    const handlePrevious = () => {
      if (!claimFire('previous')) return;
      const node = currentNodeRef.current;
      if (!node) return;
      const navigateToTarget = navigateToTargetRef.current;
      const goBack = goBackRef.current;
      if (!navigateToTarget || !goBack) return;
      switch (prevAction) {
        case 'choice2': {
          // Falls back to goBack when there's no second choice, mirroring
          // how 'choice1' falls back to the node's divert. Without it the
          // previous-track button was inert on every linear node — and on
          // EVERY node during narration, since choices aren't offered
          // until the passage ends. Registered, wired, and silently doing
          // nothing is indistinguishable from broken to a listener whose
          // only feedback is audio.
          const choice = node.choices[1];
          if (choice) navigateToTarget(choice.target);
          else goBack();
          break;
        }
        case 'cycle_choices':
          if (node.choices.length > 0) {
            setSelectedChoice((c) => Math.max(0, c - 1));
          }
          break;
        case 'go_back':
          goBack();
          break;
        default:
          console.warn('[wanderline] Unknown bluetooth previousTrack action:', prevAction);
      }
    };

    const handleSeekForward = () => {
      if (!claimFire('seekforward')) return;
      const node = currentNodeRef.current;
      if (!node) return;
      const navigateToTarget = navigateToTargetRef.current;
      const navigateToNode = navigateToNodeRef.current;
      if (!navigateToTarget || !navigateToNode) return;
      if (node.choices.length > 0) {
        const choice = node.choices[0];
        if (choice) navigateToTarget(choice.target);
      } else {
        const onward = onwardFrom(node, story);
        if (onward) navigateToNode(onward);
      }
    };

    const handleSeekBackward = () => {
      if (!claimFire('seekbackward')) return;
      goBackRef.current?.();
    };

    return { handlePlayPause, handleNext, handlePrevious, handleSeekForward, handleSeekBackward };
    // Deps hold ONLY values that change with real state — the ref
    // objects (navigateToTargetRef, etc.) have stable identity from
    // App.tsx's useRef, so listing them is a no-op that also
    // satisfies exhaustive-deps.
  }, [
    story,
    showInstructions,
    story?.settings?.bluetoothControls?.nextTrack,
    story?.settings?.bluetoothControls?.previousTrack,
    claimFire,
    navigateToTargetRef,
    navigateToNodeRef,
    goBackRef,
    onHeadphoneButtonPressRef,
    currentNodeRef,
    selectedChoiceRef,
    setSelectedChoice,
  ]);

  // 3. Keep the keydown-fallback refs current with the latest action
  // closures regardless of MediaSession presence. Cleared on
  // teardown so a stale closure can't fire after unmount.
  useEffect(() => {
    handleMediaNextRef.current = mediaActions?.handleNext ?? null;
    handleMediaPreviousRef.current = mediaActions?.handlePrevious ?? null;
    return () => {
      handleMediaNextRef.current = null;
      handleMediaPreviousRef.current = null;
    };
  }, [mediaActions]);

  // 4. Install the same action closures on the MediaSession bus when
  // available. Bound once per story (and per show-/hide-instructions
  // transition) — all dynamic state reads through refs to avoid the
  // unbind/rebind window where iOS Safari can drop Bluetooth events.
  // Captured `ms` (see effect 1) — same stability rationale.
  useEffect(() => {
    if (!mediaActions) return;
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.setActionHandler('play', mediaActions.handlePlayPause);
    ms.setActionHandler('pause', mediaActions.handlePlayPause);
    ms.setActionHandler('nexttrack', mediaActions.handleNext);
    ms.setActionHandler('previoustrack', mediaActions.handlePrevious);
    ms.setActionHandler('seekforward', mediaActions.handleSeekForward);
    ms.setActionHandler('seekbackward', mediaActions.handleSeekBackward);
    return () => {
      ms.setActionHandler('play', null);
      ms.setActionHandler('pause', null);
      ms.setActionHandler('nexttrack', null);
      ms.setActionHandler('previoustrack', null);
      ms.setActionHandler('seekforward', null);
      ms.setActionHandler('seekbackward', null);
    };
  }, [mediaActions]);

  // 5.: window-level keydown fallback for wired IEMs whose
  // inline-button presses surface as KeyboardEvents rather than via
  // navigator.mediaSession.
  useEffect(() => {
    if (!story) return;
    const handleMediaKey = (e: KeyboardEvent) => {
      // OS / hardware auto-repeat on a sticky inline-button can flood
      // keydown at ~30Hz. processClick would then interpret the burst
      // as a triple-click and navigate to choices[1] instead of
      // toggling pause. Drop repeats — a deliberate press always
      // sends `repeat=false` for the first event.
      if (e.repeat) return;
      // Stand down for keystrokes typed into a field. Deliberately
      // narrower than the App-level shortcut guard: this handler only
      // claims Media* keys, which no button or link consumes for
      // activation, so bailing on any focused interactive element would
      // silently kill headphone control the moment a listener tapped
      // the on-screen Play button and left focus sitting on it.
      if (isFromTextEntry(e)) return;
      const isPlayPause = MEDIA_KEYS_PLAY_PAUSE.has(e.key);
      const isNext = MEDIA_KEYS_NEXT.has(e.key);
      const isPrev = MEDIA_KEYS_PREVIOUS.has(e.key);
      if (!isPlayPause && !isNext && !isPrev) return;
      // Instructions screen: any media-key press starts the story
      // (mirrors the parallel MediaSession effect). On the password
      // screen we let the press through unhandled — preventDefault
      // would swallow it with no visible effect.
      if (showInstructions) {
        e.preventDefault();
        startStoryRef.current?.();
        return;
      }
      if (!isAuthenticated) return;
      e.preventDefault();
      if (isPlayPause) {
        // Stamp via the mediaActions handlers (they call claimFire
        // internally) by going through the MediaSession-equivalent
        // handlePlayPause closure. Falls back to direct invocation
        // on the headphone-button ref if mediaActions isn't built
        // yet (story still loading).
        if (mediaActions) mediaActions.handlePlayPause();
        else onHeadphoneButtonPressRef.current?.();
      } else if (isNext) {
        if (mediaActions) mediaActions.handleNext();
        else handleMediaNextRef.current?.();
      } else if (isPrev) {
        if (mediaActions) mediaActions.handlePrevious();
        else handleMediaPreviousRef.current?.();
      }
    };
    window.addEventListener('keydown', handleMediaKey);
    return () => window.removeEventListener('keydown', handleMediaKey);
    // story?.id narrows the dep so transient story-object refreshes
    // (collab re-seed, metadata refetch) don't tear down + rebind
    // the listener — same iOS Safari Bluetooth-drop concern that
    // the MediaSession effect documents.
  }, [story?.id, showInstructions, isAuthenticated, mediaActions, onHeadphoneButtonPressRef]);

  // 6. Keep MediaSession metadata + playbackState fresh as the user
  // navigates / playback transitions. Separated from the binding effect
  // so updating metadata doesn't require tearing down all action
  // handlers (iOS Safari can drop Bluetooth events during rebind).
  useEffect(() => {
    if (!story || !currentNode || showInstructions) return;
    const ms = navigator.mediaSession;
    if (!ms) return;
    const trimmedTranscript = currentNode.metadata?.transcript?.trim();
    ms.metadata = new MediaMetadata({
      title:
        (trimmedTranscript && trimmedTranscript.slice(0, 50)) ||
        currentNode.content[0]?.text.slice(0, 50) ||
        currentNode.id,
      artist: story.title,
      album: 'Wanderline Story',
    });
  }, [story, currentNode, showInstructions]);

  // 7. Mirror playerState onto MediaSession's playbackState so the OS
  // sees a matching transport state.
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    // 'none' tells the OS this page has no media session at all, and it
    // stops routing next/previous to the headset — play/pause survives
    // only because browsers service that against the media element
    // directly. Four of the six PlayerStates used to map here, including
    // 'ended', which is the state the player sits in for the whole
    // choice-prompt phase: audio is audible (through separate elements
    // that never set 'playing'), the listener is being asked to choose,
    // and their skip buttons are dead.
    //
    // So only report 'none' when there is genuinely no story. 'ended'
    // reports 'playing' because the choice prompts are sounding;
    // everything else in-between reports 'paused', which keeps the
    // session alive without claiming audio that isn't there.
    if (!story) {
      ms.playbackState = 'none';
    } else if (playerState === 'playing' || playerState === 'ended') {
      ms.playbackState = 'playing';
    } else {
      ms.playbackState = 'paused';
    }
  }, [playerState, story]);

  return { mediaActions };
}
