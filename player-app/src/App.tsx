import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useOfflineSupport } from './useOfflineSupport';
import { useMediaControls } from './useMediaControls';
import { useAudioCache } from './useAudioCache';
import { orderAudioUrlsForDownload } from './audio-download-order';
import OfflineControls from './OfflineControls';
import { styles } from './styles';
import {
  Play,
  SkipNext,
  SkipPrev,
  Settings,
  Refresh,
  ChatBubble,
  WarningTriangle,
} from 'iconoir-react';
import {
  AUTOSAVE_SLOT_ID,
  clearAllSlots,
  defaultManualSlotName,
  hasStoredSlots,
  newSlotId,
  readSlotsWithMigration,
  removeSlot,
  upsertSlot,
  writeSlots,
  type SaveSlot,
} from './save-slots';

// Load story data from window (preview), fetch (generated app), or demo
async function loadStoryData(): Promise<StoryData | null> {
  // 1. Check for injected story data (preview mode)
  if ((window as unknown as Record<string, unknown>).__WANDERLINE_STORY__) {
    return (window as unknown as Record<string, unknown>)
      .__WANDERLINE_STORY__ as unknown as StoryData;
  }
  // 2. Try fetching story.json (generated app)
  try {
    const response = await fetch('./story.json');
    if (response.ok) return await response.json();
  } catch {}
  // 3. Check URL parameter
  const params = new URLSearchParams(window.location.search);
  const storyUrl = params.get('story');
  if (storyUrl) {
    try {
      const response = await fetch(storyUrl);
      if (response.ok) return await response.json();
    } catch {}
  }
  return null;
}

interface StoryNode {
  id: string;
  type: string;
  content: { text: string }[];
  choices: { text: string; target: string }[];
  divert: string | null;
  tags: string[];
  audio?: { voiceover?: string; ambience?: string; choice1?: string; choice2?: string };
  metadata?: {
    // Postgres column is nullable; story-data-builder forwards
    // `row.transcript` which can be null. `string | null` matches
    // runtime JSON. Player code already guards with `?.` + truthy
    // check, which handles null correctly.
    transcript?: string | null;
    delayBeforeMs?: number;
    delayAfterMs?: number;
    autoAdvance?: boolean;
    autoAdvanceDelayMs?: number;
    choice1TimestampMs?: number;
    choice2TimestampMs?: number;
    theme?: string;
  };
}

interface StoryData {
  id: string;
  title: string;
  audioBaseUrl: string;
  startNode: string;
  nodes: Record<string, StoryNode>;
  indicatorAudio?: { choice1?: string; choice2?: string };
  settings?: {
    password?: string;
    backgroundMusicVolume?: number;
    indicatorVolume?: number;
    choiceAudioDelayMs?: number;
    // UI options — all default to "on" when unset. Set via the editor's
    // Settings tab; see project_settings JSONB on the backend.
    captionsDefault?: boolean;
    autoAdvance?: boolean;
    showProgressBar?: boolean;
    showChoiceList?: boolean;
    // Bluetooth / headphone button mapping.
    bluetoothControls?: {
      nextTrack?: 'choice1' | 'cycle_choices' | 'confirm' | 'divert';
      previousTrack?: 'choice2' | 'cycle_choices' | 'go_back';
    };
  };
  backgroundMusic?: string[];
}

type PlayerState = 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

type PreloadState = 'idle' | 'loading' | 'complete' | 'error';

import { fallThroughTarget } from './fall-through';
export { fallThroughTarget };

// One resolver for every reference in the story — see node-reference.ts
// for why it lives outside this file. Re-exported because the player's
// tests reach for it here, alongside the session logic that uses it.
import { hasNode, resolveNodeReference, stepTo } from './node-reference';
export { resolveNodeReference };

const STORAGE_PREFIX = 'wanderline_';

// Safe storage helpers for file:// URL compatibility
const safeGetItem = (storage: Storage, key: string): string | null => {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};
const safeSetItem = (storage: Storage, key: string, value: string): void => {
  try {
    storage.setItem(key, value);
  } catch {}
};

// Theme colors for character-based styling
const THEME_COLORS: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  red: { bg: 'rgba(239,68,68,0.15)', border: '#ef4444', text: '#fecaca', accent: '#f87171' },
  orange: { bg: 'rgba(249,115,22,0.15)', border: '#f97316', text: '#fed7aa', accent: '#fb923c' },
  yellow: { bg: 'rgba(234,179,8,0.15)', border: '#eab308', text: '#fef08a', accent: '#facc15' },
  green: { bg: 'rgba(34,197,94,0.15)', border: '#22c55e', text: '#bbf7d0', accent: '#4ade80' },
  blue: { bg: 'rgba(59,130,246,0.15)', border: '#3b82f6', text: '#bfdbfe', accent: '#60a5fa' },
  indigo: { bg: 'rgba(99,102,241,0.15)', border: '#6366f1', text: '#c7d2fe', accent: '#818cf8' },
  purple: { bg: 'rgba(168,85,247,0.15)', border: '#a855f7', text: '#e9d5ff', accent: '#c084fc' },
  pink: { bg: 'rgba(236,72,153,0.15)', border: '#ec4899', text: '#fbcfe8', accent: '#f472b6' },
};

// Click detection for headphone controls
const CLICK_TIMEOUT = 400;

// Background music play() retries. Sized for transient rejections (an
// autoplay policy, or an element still settling after the tab was
// backgrounded) rather than a genuinely missing file, which onerror
// already handles by skipping to the next track.
const BGM_PLAY_MAX_RETRIES = 3;
const BGM_RETRY_BASE_MS = 1000;

interface ClickDetectionState {
  clickCount: number;
  lastClickTime: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface ClickHandlers {
  onSingleClick: () => void;
  onDoubleClick: () => void;
  onTripleClick: () => void;
}

function processClick(
  state: ClickDetectionState,
  currentTime: number,
  handlers: ClickHandlers,
): ClickDetectionState {
  if (state.timeoutId !== null) {
    clearTimeout(state.timeoutId);
  }

  const timeSinceLastClick = currentTime - state.lastClickTime;
  const newClickCount = timeSinceLastClick < CLICK_TIMEOUT ? state.clickCount + 1 : 1;

  const timeoutId = setTimeout(() => {
    if (newClickCount === 1) handlers.onSingleClick();
    else if (newClickCount === 2) handlers.onDoubleClick();
    else if (newClickCount >= 3) handlers.onTripleClick();
  }, CLICK_TIMEOUT);

  return {
    clickCount: newClickCount,
    lastClickTime: currentTime,
    timeoutId,
  };
}

/**
 * Where a passage goes when it advances on its own, or null if it
 * shouldn't.
 *
 * Two rules, both deliberate:
 *
 *  - It is entirely a project setting. There is no per-node override.
 *    Auto-advance was previously on unless a node refused, and a node
 *    with no metadata row — the common case — didn't refuse, so
 *    effectively every passage advanced whether or not anyone chose it.
 *
 *  - It only applies where there is exactly one way forward: a single
 *    choice, or a divert with no choices. A passage offering a real
 *    decision must never take it on the listener's behalf, which is
 *    the difference between a story that flows and one that runs away.
 */
export function autoAdvanceTarget(
  node:
    | {
        id?: string;
        type?: string;
        parent?: string | null;
        choices?: { target: string }[];
        divert?: string | null;
      }
    | null
    | undefined,
  settings: { autoAdvance?: boolean } | undefined,
  // Optional: pass the story's nodes to also advance across Ink's
  // implicit continuation. Without it a fall-through passage stalls
  // with auto-advance on, while the manual Continue button works —
  // the setting would make the story *less* able to progress.
  nodes?: Record<
    string,
    { id: string; type?: string; parent?: string | null; lineNumber?: number }
  >,
): string | null {
  if (settings?.autoAdvance !== true || !node) return null;
  const choices = node.choices ?? [];
  if (choices.length === 1) return choices[0]?.target ?? null;
  if (choices.length === 0 && node.divert) return node.divert;
  if (choices.length === 0 && nodes && node.id) return fallThroughTarget(node.id, node, nodes);
  return null;
}

function createInitialClickState(): ClickDetectionState {
  return { clickCount: 0, lastClickTime: 0, timeoutId: null };
}

/**
 * What the URL asks of this session.
 *
 *  - `start`: begin at a named passage.
 *  - `fresh`: begin at the story's own start node, ignoring any save.
 *
 * Either one marks the session a REVIEW pass rather than a listen: it
 * neither resumes the autosave nor writes over it. Both arrive from
 * the editor's preview, where the point is to hear one passage, and
 * where quietly overwriting the listener's forty-minutes-in autosave
 * with a review position would destroy progress they can't get back.
 *
 * Read straight off `window.location` rather than plumbed through
 * loadStoryData, because the story itself can arrive by any of three
 * routes (injected, fetched, ?story=) and where to begin is orthogonal
 * to all of them.
 */
export function readSessionParams(): { start: string | null; fresh: boolean } {
  if (typeof window === 'undefined') return { start: null, fresh: false };
  try {
    const params = new URLSearchParams(window.location.search);
    const trimmed = params.get('start')?.trim();
    return { start: trimmed ? trimmed : null, fresh: params.get('fresh') === '1' };
  } catch {
    return { start: null, fresh: false };
  }
}

/**
 * The one place that decides where a session begins.
 *
 * There are two independent claims on that decision — the `?start=`
 * pin and a saved autosave — and having them argue at the call site is
 * how the player ends up starting somewhere other than what it just
 * told the listener on screen. So: one function, one answer, and the
 * notice, the history and the save behaviour all read off it.
 *
 * Precedence:
 *
 *  1. A `?start=` that resolves. The autosave is an inference about
 *     where you probably want to be; the parameter is somebody saying
 *     so, and anyone arriving on one has just clicked "Preview from
 *     here" on a specific passage.
 *  2. Any review request at all — a `?start=` that matched nothing, or
 *     `?fresh=1` — begins at the story's own start. Falling back to the
 *     autosave here would drop the listener somewhere they never asked
 *     for while the screen says "starting from the beginning".
 *  3. The autosave, when it diverges from the start node.
 *  4. The start node.
 *
 * `protectSaves` says this session may not write or clear the saves on
 * this device. A session records progress only when it BEGAN where a
 * listen would begin:
 *
 *   - Jumping in (a `?start=` that resolved) is never recorded. Hearing
 *     one passage to check a fix is not progress, and a jumped-in
 *     position silently becoming "where you were" is a surprise nobody
 *     asked for — including on a fresh device, where it would leave the
 *     next plain preview opening mid-story.
 *   - Any review session that finds saves already here leaves them
 *     alone: neither recording over that listener's position nor wiping
 *     their slots is ours to do — including slots this build can no
 *     longer use, which are still someone's data on disk.
 *   - A `?fresh=1` run on a device with no saves records normally.
 *     It starts at the beginning and plays forward — that IS a listen,
 *     and refusing to record it protects nothing.
 */
export function resolveSessionStart(
  story: { startNode: string; nodes: Record<string, unknown> },
  /** The usable slots on this device for this story, autosave included. */
  savedSlots: { id: string; nodeId: string; history: string[] }[],
  params: { start: string | null; fresh: boolean },
  /** Whether this device holds any stored save data at all, including
   * slots the current graph can no longer use. Those are filtered out
   * of `savedSlots` in memory but stay on disk, and Restart would still
   * erase them — so "is there anything here to protect?" has to ask
   * storage. Defaults to what `savedSlots` shows. */
  hasStoredSaves: boolean = savedSlots.length > 0,
): {
  nodeId: string;
  history: string[];
  /** This session must not write or clear the saves that already exist. */
  protectSaves: boolean;
  /** What `?start=` asked for, or null when it asked for nothing. */
  requested: string | null;
  /** What that request resolved to, or null when nothing matched. */
  resolved: string | null;
} {
  const requested = params.start;
  // Resolve against the start node's knot: before the listener has
  // moved there is no "current" knot, and the start node is the
  // closest thing to one.
  const resolved = requested ? resolveNodeReference(requested, story.nodes, story.startNode) : null;
  const reviewSession = Boolean(requested || params.fresh);
  const protectSaves = reviewSession && (hasStoredSaves || resolved !== null);
  if (resolved) {
    // No history: we jumped in rather than walked here, so there is no
    // route back. An empty history is honest about that — Back does
    // nothing rather than replaying a path the listener never took.
    return { nodeId: resolved, history: [], protectSaves, requested, resolved };
  }
  if (reviewSession) {
    return { nodeId: story.startNode, history: [], protectSaves, requested, resolved };
  }
  // Auto-resume the autosave only when it diverges from the start node
  // — otherwise we'd surface a "Resume?" affordance for a brand-new
  // story the listener has only just opened.
  const autosave = savedSlots.find((s) => s.id === AUTOSAVE_SLOT_ID);
  if (autosave && autosave.nodeId !== story.startNode) {
    return {
      nodeId: autosave.nodeId,
      history: autosave.history,
      protectSaves,
      requested,
      resolved,
    };
  }
  return { nodeId: story.startNode, history: [], protectSaves, requested, resolved };
}

/**
 * Drop any in-flight multi-click run.
 *
 * The tally has to be cleared when the story moves, or presses from
 * either side of a node boundary combine into one gesture: a press on
 * the passage you just left, plus a press on the one you just arrived
 * at, counts as a double-click and navigates again. To a listener that
 * reads as the story advancing on its own.
 */
function resetClickState(state: ClickDetectionState): ClickDetectionState {
  if (state.timeoutId !== null) clearTimeout(state.timeoutId);
  return createInitialClickState();
}

export default function App() {
  const offline = useOfflineSupport();
  const [story, setStory] = useState<StoryData | null>(null);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [selectedChoice, setSelectedChoice] = useState(0);
  const [playerState, setPlayerState] = useState<PlayerState>('loading');
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioStalled, setAudioStalled] = useState(false);
  const [retryingAudio, setRetryingAudio] = useState(false);
  const [showConnectionIssue, setShowConnectionIssue] = useState(false);
  const audioRetryCountRef = useRef(0);
  const audioRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Separate from audioRetryTimeoutRef so a `delayBeforeMs` pre-roll
  // and a concurrent retry timeout can't race on the same ref.
  const prerollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionIssueTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [audioSkipped, setAudioSkipped] = useState(false);
  const [showInstructions, setShowInstructions] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Auto-advance: the project setting is only the DEFAULT. A listener
  // who sets it owns it from then on, including across an author
  // changing that default. Off until the story resolves it, so a slow
  // load never advances on its own.
  const [autoAdvance, setAutoAdvance] = useState(false);
  // Read where a passage ends rather than through the effect's deps:
  // adding it there would re-run the audio effect and restart
  // narration under a listener who toggled mid-passage.
  const autoAdvanceRef = useRef(false);
  const [voiceoverVolume, setVoiceoverVolume] = useState(100);
  const [userIndicatorVolume, setUserIndicatorVolume] = useState(50);
  // Fallbacks are the last link in the resolution chain below, so they
  // must match the editor's own defaults (frontend VolumesTab): 100 /
  // 30 / 50. This one said 100, and only looked right because the
  // apply sites were multiplying by the project setting a second time.
  const [userBgMusicVolume, setUserBgMusicVolume] = useState(30);
  // False until the story's volume settings and any per-device override
  // have been resolved. Guards the persist effect above.
  const volumesHydratedRef = useRef(false);
  // Auto-continue used to be surfaced as a listener-facing toggle
  // (pre-start settings + in-story cog panel). Author feedback was
  // that most listeners want the paced audio-drama experience and
  // that skipping past single-choice nodes breaks the beat; the
  // toggle got turned off almost immediately when listeners noticed
  // it. Default is now off and the UI surface is removed. The
  // state + auto-navigate branch stay so a future re-enable (or
  // per-project override) is a small change: reintroduce the
  // setter here via `const [autoContinue, setAutoContinue] =
  // useState(...)` and wire a new UI surface / prop.
  const [autoContinue] = useState(false);
  const [reachedEnding, setReachedEnding] = useState(false);
  // multi-slot save state. `saveSlots` is sourced from
  // localStorage on story load (with legacy single-slot migration).
  // The autosave path writes into the slot with id="autosave"; manual
  // slots are created from the Save Slots panel.
  const [saveSlots, setSaveSlots] = useState<SaveSlot[]>([]);
  const [preloadState, setPreloadState] = useState<PreloadState>('idle');
  // What `?start=` asked for and what it resolved to (null = nothing
  // in this story matches). Kept so the instructions screen can say
  // where playback is about to begin — silently starting somewhere
  // other than the beginning, or silently ignoring the request, both
  // leave the listener unable to trust what they're hearing.
  const [startRequest, setStartRequest] = useState<{
    requested: string;
    resolved: string | null;
  } | null>(null);
  // The one gate on this story's persisted saves.
  //
  // True for a review session that found saves already here: it exists
  // to check one passage, and the listener whose forty-minutes-in
  // position is in that slot did not ask for a reviewer's jump to
  // replace it — or, through Restart, to delete every slot they have.
  //
  // It gates the writes the listener did NOT ask for: the autosave, and
  // Restart's wipe. Explicitly saving, renaming, deleting or loading a
  // slot is the listener asking, and goes through regardless.
  //
  // A ref, not state, because saveProgress runs inside navigation and
  // has to see the current value without waiting for a re-render.
  const protectSavesRef = useRef(false);
  const mayTouchSavedState = useCallback(() => !protectSavesRef.current, []);

  // audio cache layer (preloadAudio, getCachedAudio,
  // retryFailedAudio, isCached, preloadProgress). Owns audioCacheRef
  // internally; the hook also exposes `cacheRef` for the follow-up
  // playback extraction that will pull voiceover/bgm/indicators out.
  const { preloadAudio, getCachedAudio, retryFailedAudio, isCached, resetPreloadProgress } =
    useAudioCache();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentNodeIdRef = useRef<string | null>(null);
  // MediaSession refs: handlers read these so they can fire
  // correctly without forcing the binding effect to re-subscribe on
  // every state change (which on iOS Safari can drop a Bluetooth event
  // during the unbind/rebind window) and without capturing stale state
  // in their closures.
  const selectedChoiceRef = useRef(0);
  const playerStateRef = useRef<PlayerState>('loading');
  const currentNodeRef = useRef<StoryNode | null>(null);
  const navigateToTargetRef = useRef<((target: string) => void) | null>(null);
  const goBackRef = useRef<(() => void) | null>(null);
  const handleHeadphoneButtonPressRef = useRef<(() => void) | null>(null);
  const clickStateRef = useRef<ClickDetectionState>(createInitialClickState());
  const pendingAutoplayNodeIdRef = useRef<string | null>(null);
  const choice1IndicatorRef = useRef<HTMLAudioElement | null>(null);
  const choice2IndicatorRef = useRef<HTMLAudioElement | null>(null);

  // Background music
  const bgMusicRef = useRef<HTMLAudioElement | null>(null);
  const bgMusicIndexRef = useRef(0);
  const bgmRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playedIndicatorsRef = useRef({ choice1: false, choice2: false });
  const choiceRepeatIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoNavigateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every playVoiceover call so async work started by an
  // earlier call can tell it has been superseded, including when the
  // listener restarts the SAME node. See playVoiceover for why node id
  // alone was not enough.
  const playbackEpochRef = useRef(0);
  // Last position reported by ontimeupdate, so a retry after a stall can
  // pick up where the narration actually stopped instead of restarting.
  const lastPositionRef = useRef(0);
  const choice1AudioRef = useRef<HTMLAudioElement | null>(null);
  const choice2AudioRef = useRef<HTMLAudioElement | null>(null);

  // Keep ref in sync with state for async callbacks
  useEffect(() => {
    currentNodeIdRef.current = currentNodeId;
  }, [currentNodeId]);

  // Cleanup click detection timeout on unmount
  useEffect(() => {
    return () => {
      if (clickStateRef.current.timeoutId !== null) {
        clearTimeout(clickStateRef.current.timeoutId);
      }
    };
  }, []);

  useEffect(() => {
    // Load story data from window (preview), fetch (generated app), or URL param
    loadStoryData()
      .then((data) => {
        if (!data) {
          setPlayerState('error');
          setAudioError('Failed to load story data');
          return;
        }
        setStory(data);

        // Honor the project's captions-default UI option. Explicit
        // `false` turns captions off initially; anything else (including
        // unset) keeps them on.
        if (data.settings?.captionsDefault === false) {
          setCaptionsEnabled(false);
        }

        // Check if password is required and if already authenticated
        if (data.settings?.password) {
          const authKey = STORAGE_PREFIX + data.id + '_auth';
          const isAuth = safeGetItem(sessionStorage, authKey) === 'true';
          setIsAuthenticated(isAuth);
        } else {
          setIsAuthenticated(true);
        }

        // load + migrate save slots, then pick a starting node.
        const validNodeIds = new Set(Object.keys(data.nodes));
        const loadedSlots = readSlotsWithMigration(data.id, validNodeIds);
        setSaveSlots(loadedSlots);

        // Where this session begins — `?start=` / `?fresh=1` versus the
        // autosave — is decided in one place. See resolveSessionStart.
        // Whatever it returns is what the instructions screen reports,
        // so the two can't disagree.
        //
        // Every slot stays listed on the instructions screen either
        // way, so resuming is one click away even from a review
        // session.
        const session = resolveSessionStart(
          data,
          loadedSlots,
          readSessionParams(),
          hasStoredSlots(data.id),
        );
        // Set BEFORE anything can navigate: it gates every autosave
        // write for the rest of the run.
        protectSavesRef.current = session.protectSaves;
        if (session.requested) {
          setStartRequest({ requested: session.requested, resolved: session.resolved });
          if (!session.resolved) {
            console.warn('[wanderline] ?start= passage not found in story graph', {
              requested: session.requested,
              knownNodes: Object.keys(data.nodes).length,
            });
          }
        }
        setCurrentNodeId(session.nodeId);
        setHistory(session.history);

        // Volume resolution order: per-device localStorage override
        // wins (the listener set it explicitly), otherwise the
        // project's author-chosen default from settings, otherwise
        // the hardcoded fallback.
        //
        // The state these seed IS the effective volume — apply it as
        // `state / 100` and nothing else. The apply sites used to
        // multiply by story.settings a second time, squaring the
        // author's choice: a 30% music default played at 9%, a 50%
        // indicator default at 25%. Voiceover escaped only because
        // its default is 100 and 1 x 1 = 1.
        const s = (data.settings ?? {}) as {
          voiceoverVolume?: number;
          backgroundMusicVolume?: number;
          indicatorVolume?: number;
          autoAdvance?: boolean;
        };
        if (typeof s.voiceoverVolume === 'number') setVoiceoverVolume(s.voiceoverVolume);
        if (typeof s.indicatorVolume === 'number') setUserIndicatorVolume(s.indicatorVolume);
        if (typeof s.backgroundMusicVolume === 'number')
          setUserBgMusicVolume(s.backgroundMusicVolume);
        // Auto-advance resolves the same way, but per story rather than
        // per device: it is a fact about how this story reads, and a
        // standalone build is its own origin anyway.
        if (typeof s.autoAdvance === 'boolean') setAutoAdvance(s.autoAdvance);
        const savedAutoAdvance = safeGetItem(
          localStorage,
          STORAGE_PREFIX + data.id + '_autoAdvance',
        );
        if (savedAutoAdvance === 'true' || savedAutoAdvance === 'false') {
          setAutoAdvance(savedAutoAdvance === 'true');
        }

        const savedVolumes = safeGetItem(localStorage, STORAGE_PREFIX + 'volumes');
        if (savedVolumes) {
          try {
            const volumes = JSON.parse(savedVolumes);
            if (volumes.voiceover !== undefined) setVoiceoverVolume(volumes.voiceover);
            if (volumes.indicator !== undefined) setUserIndicatorVolume(volumes.indicator);
            if (volumes.bgMusic !== undefined) setUserBgMusicVolume(volumes.bgMusic);
          } catch {}
        }
        // Resolution is complete; the listener's own changes from here
        // on are theirs to keep.
        volumesHydratedRef.current = true;
        setPlayerState('ready');
      })
      .catch(() => {
        setPlayerState('error');
        setAudioError('Failed to load story data');
      });
  }, []);

  // Helper to get reachable nodes from a starting point (BFS up to depth)
  const getReachableNodes = useCallback(
    (startNodeId: string, nodes: Record<string, StoryNode>, maxDepth: number): string[] => {
      const visited = new Set<string>();
      const queue: Array<{ id: string; depth: number }> = [{ id: startNodeId, depth: 0 }];
      // Follow references the same way playback does (stepTo). Walking
      // raw targets and dropping the ones that miss meant a story
      // imported from compiled .ink.json — where diverts and choice
      // targets are routinely bare stitch names — preloaded almost
      // nothing: the walk stopped at the first bare name, so the
      // passages about to play were the ones NOT warmed, and the
      // listener met a network fetch exactly where the preload existed
      // to prevent one.
      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if (visited.has(id) || depth > maxDepth) continue;
        if (!hasNode(nodes, id)) continue;

        visited.add(id);
        const node = nodes[id];

        for (const choice of node.choices || []) {
          const target = stepTo(choice.target, nodes, id);
          if (target) queue.push({ id: target, depth: depth + 1 });
        }
        const divert = stepTo(node.divert, nodes, id);
        if (divert) queue.push({ id: divert, depth: depth + 1 });
        // And the implicit continuation, or the listener meets a network
        // fetch and the stall banner at exactly the transition
        // auto-advance was added to smooth over.
        const onward = fallThroughTarget(id, node, nodes);
        if (onward) queue.push({ id: onward, depth: depth + 1 });
      }

      return Array.from(visited);
    },
    [],
  );

  // Preload audio progressively - critical first, then background
  useEffect(() => {
    if (!story || preloadState !== 'idle') return;

    // Priority 1: Background music (first track only), indicators
    const criticalFiles: Array<{ key: string; url: string }> = [];

    if (story.backgroundMusic?.length) {
      criticalFiles.push({ key: 'bgm_0', url: story.audioBaseUrl + story.backgroundMusic[0] });
    }
    if (story.indicatorAudio?.choice1) {
      criticalFiles.push({ key: 'ind_c1', url: story.audioBaseUrl + story.indicatorAudio.choice1 });
    }
    if (story.indicatorAudio?.choice2) {
      criticalFiles.push({ key: 'ind_c2', url: story.audioBaseUrl + story.indicatorAudio.choice2 });
    }

    // Priority 2: the first few passages reachable from WHERE THIS
    // SESSION BEGINS (depth 2 = that passage + 2 levels of choices).
    // Not story.startNode: a `?start=` pin normally sits well outside
    // depth 2 of the opening, so warming from the opening left the one
    // file the reviewer came for in the background batch — Start would
    // finish "Preparing..." and then hit a network fetch and the stall
    // banner on the very passage being checked.
    const preloadRoot = currentNodeId ?? story.startNode;
    const nearbyNodeIds = getReachableNodes(preloadRoot, story.nodes, 2);
    for (const nodeId of nearbyNodeIds) {
      const node = story.nodes[nodeId];
      if (node?.audio?.voiceover) {
        criticalFiles.push({ key: 'vo_' + nodeId, url: story.audioBaseUrl + node.audio.voiceover });
      }
      if (node?.audio?.choice1) {
        criticalFiles.push({ key: 'c1_' + nodeId, url: story.audioBaseUrl + node.audio.choice1 });
      }
      if (node?.audio?.choice2) {
        criticalFiles.push({ key: 'c2_' + nodeId, url: story.audioBaseUrl + node.audio.choice2 });
      }
    }

    // Remaining files (loaded in background after start)
    const backgroundFiles: Array<{ key: string; url: string }> = [];
    const criticalKeys = new Set(criticalFiles.map((f) => f.key));

    // Remaining background music tracks
    if (story.backgroundMusic && story.backgroundMusic.length > 1) {
      for (let i = 1; i < story.backgroundMusic.length; i++) {
        backgroundFiles.push({
          key: 'bgm_' + i,
          url: story.audioBaseUrl + story.backgroundMusic[i],
        });
      }
    }

    // Remaining nodes
    for (const [nodeId, node] of Object.entries(story.nodes)) {
      if (node.audio?.voiceover && !criticalKeys.has('vo_' + nodeId)) {
        backgroundFiles.push({
          key: 'vo_' + nodeId,
          url: story.audioBaseUrl + node.audio.voiceover,
        });
      }
      if (node.audio?.choice1 && !criticalKeys.has('c1_' + nodeId)) {
        backgroundFiles.push({ key: 'c1_' + nodeId, url: story.audioBaseUrl + node.audio.choice1 });
      }
      if (node.audio?.choice2 && !criticalKeys.has('c2_' + nodeId)) {
        backgroundFiles.push({ key: 'c2_' + nodeId, url: story.audioBaseUrl + node.audio.choice2 });
      }
    }

    const totalFiles = criticalFiles.length + backgroundFiles.length;
    if (totalFiles === 0) {
      setPreloadState('complete');
      return;
    }

    setPreloadState('loading');
    resetPreloadProgress(criticalFiles.length);

    // Load critical files first with concurrency
    const CONCURRENCY = 4;
    let criticalIndex = 0;
    const loadCritical = async (): Promise<void> => {
      while (criticalIndex < criticalFiles.length) {
        const file = criticalFiles[criticalIndex++];
        await preloadAudio(file.url, file.key);
      }
    };

    Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, criticalFiles.length) }, loadCritical),
    ).then(() => {
      // Critical files done - mark as complete so user can start
      setPreloadState('complete');

      // Continue loading background files silently
      if (backgroundFiles.length > 0) {
        let bgIndex = 0;
        const loadBackground = async (): Promise<void> => {
          while (bgIndex < backgroundFiles.length) {
            const file = backgroundFiles[bgIndex++];
            await preloadAudio(file.url, file.key);
          }
        };
        // Load background files with lower concurrency to not impact playback
        Promise.all(Array.from({ length: Math.min(2, backgroundFiles.length) }, loadBackground));
      }
    });
    // currentNodeId is a dep so a pinned session warms its own
    // neighbourhood. It can't re-run the preload on every navigation:
    // the guard above returns immediately once preloadState leaves
    // 'idle', which happens on this effect's first pass.
  }, [story, currentNodeId, preloadState, preloadAudio, getReachableNodes]);

  // Background music playback - independent of other audio and headphone controls
  const startBackgroundMusic = useCallback(() => {
    if (!story?.backgroundMusic?.length) return;
    if (bgMusicRef.current && !bgMusicRef.current.paused) return; // Already playing

    const playNextTrack = () => {
      if (!story.backgroundMusic?.length) return;

      const trackIndex = bgMusicIndexRef.current % story.backgroundMusic.length;
      const trackUrl = story.audioBaseUrl + story.backgroundMusic[trackIndex];
      const volume = userBgMusicVolume / 100;

      // Use cached audio if available
      const audio = getCachedAudio('bgm_' + trackIndex, trackUrl);
      audio.volume = volume;
      // Single-track playlists get native looping — the browser
      // handles it in-engine and survives iOS backgrounding /
      // timer throttling. Multi-track playlists still chain via
      // onended (there's no gapless-playlist API in HTMLAudio).
      const isSingleTrack = story.backgroundMusic.length === 1;
      audio.loop = isSingleTrack;
      audio.onended = isSingleTrack
        ? null
        : () => {
            bgMusicIndexRef.current = (bgMusicIndexRef.current + 1) % story.backgroundMusic!.length;
            playNextTrack();
          };
      audio.onerror = () => {
        // Skip to next track on error
        bgMusicIndexRef.current = (bgMusicIndexRef.current + 1) % story.backgroundMusic!.length;
        setTimeout(playNextTrack, 1000);
      };
      // A rejected play() used to be swallowed outright, which is the
      // one failure mode that stops the music with no error, no ended
      // event and nothing to chain from: it simply never starts again.
      // Transient rejections here are common (a resume racing an
      // autoplay policy, or an element still settling after the tab was
      // backgrounded), so retry a few times with backoff before giving
      // up. Bail out if a later call has taken over the ref, so a
      // retry cannot resurrect a track the player has moved on from.
      let attempt = 0;
      const attemptPlay = () => {
        audio.play().catch(() => {
          if (bgMusicRef.current !== audio) return;
          if (attempt >= BGM_PLAY_MAX_RETRIES) return;
          attempt += 1;
          bgmRetryTimeoutRef.current = setTimeout(attemptPlay, BGM_RETRY_BASE_MS * attempt);
        });
      };
      bgMusicRef.current = audio;
      attemptPlay();
    };

    playNextTrack();
  }, [story, userBgMusicVolume, getCachedAudio]);

  // Cleanup background music on unmount
  useEffect(() => {
    return () => {
      if (bgmRetryTimeoutRef.current) {
        clearTimeout(bgmRetryTimeoutRef.current);
        bgmRetryTimeoutRef.current = null;
      }
      if (bgMusicRef.current) {
        bgMusicRef.current.pause();
        bgMusicRef.current = null;
      }
    };
  }, []);

  // Mirror to the ref the audio effect reads. Only that — persisting
  // here would write on resolution too, freezing the author's default
  // into storage as though the listener had chosen it, so a later
  // change to that default could never reach them. Volumes had exactly
  // this fault; writing solely from the change handler below means
  // "the listener expressed a preference" is the only path that
  // records one.
  useEffect(() => {
    autoAdvanceRef.current = autoAdvance;
    // A hold scheduled from `onended` outlives the toggle otherwise, so
    // turning it off mid-passage still advanced a couple of seconds
    // later. The no-audio path already cancels via its cleanup; this is
    // the audio path catching up.
    if (!autoAdvance && autoNavigateTimeoutRef.current !== null) {
      clearTimeout(autoNavigateTimeoutRef.current);
      autoNavigateTimeoutRef.current = null;
    }
  }, [autoAdvance]);

  const chooseAutoAdvance = useCallback(
    (enabled: boolean) => {
      setAutoAdvance(enabled);
      if (story) {
        safeSetItem(localStorage, STORAGE_PREFIX + story.id + '_autoAdvance', String(enabled));
      }
    },
    [story],
  );

  // Save and apply volume settings.
  //
  // Persisting is gated on the resolution chain having run. This effect
  // fires on mount too, and it used to write the component's initial
  // state (100 / 50 / 30) to localStorage before the story had loaded.
  // The load handler then read those back as a per-device override and
  // clobbered the author's chosen defaults with them — so on a first
  // ever visit the author's settings could never win. It went unnoticed
  // because it only shows when a default differs from the initial: a
  // 60% voiceover played at 100%, while a 50% indicator (matching the
  // initial) looked perfectly correct.
  useEffect(() => {
    if (volumesHydratedRef.current) {
      safeSetItem(
        localStorage,
        STORAGE_PREFIX + 'volumes',
        JSON.stringify({
          voiceover: voiceoverVolume,
          indicator: userIndicatorVolume,
          bgMusic: userBgMusicVolume,
        }),
      );
    }
    // Apply to currently playing audio
    if (audioRef.current) audioRef.current.volume = voiceoverVolume / 100;
    if (choice1IndicatorRef.current) choice1IndicatorRef.current.volume = userIndicatorVolume / 100;
    if (choice2IndicatorRef.current) choice2IndicatorRef.current.volume = userIndicatorVolume / 100;
    if (bgMusicRef.current) bgMusicRef.current.volume = userBgMusicVolume / 100;
  }, [voiceoverVolume, userIndicatorVolume, userBgMusicVolume]);

  const currentNode = story && currentNodeId ? story.nodes[currentNodeId] : null;

  // Every audio URL referenced by the story — used by the
  // "Download for offline" button to ask the service worker to
  // precache them in one pass. Deduped because background music
  // and indicators can repeat across many nodes. audioBaseUrl is
  // normalized to have exactly one trailing slash; the backend
  // emits both forms over the years.
  // Ordered so an interrupted download leaves a playable prefix rather
  // than a random scattering of the story. See audio-download-order.ts.
  const allAudioUrls = useMemo<string[]>(() => orderAudioUrlsForDownload(story), [story]);

  // Keep MediaSession refs in sync with current state — handlers
  // installed once per story-id read these instead of closing over
  // stale values. Updating on every render is cheap and removes the
  // need to re-subscribe MediaSession handlers when selection or
  // playback state changes.
  selectedChoiceRef.current = selectedChoice;
  playerStateRef.current = playerState;
  currentNodeRef.current = currentNode;

  // Tell an embedding editor which passage is on screen, so it can
  // offer to flag THIS one. The reviewer is listening, not reading the
  // node list, and asking them to remember an id and go find it later
  // is how a noticed problem turns into a forgotten one.
  //
  // Same-origin only: the preview iframe is served from this app, so
  // the parent origin is ours and there's no reason to broadcast the
  // reader's position to an arbitrary embedder.
  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;
    if (!currentNodeId) return;
    try {
      window.parent.postMessage(
        { type: 'wanderline:node', nodeId: currentNodeId },
        window.location.origin,
      );
    } catch {
      // A cross-origin embed rejects the targeted post. Nothing to do:
      // this is an editor convenience, not part of playback.
    }
  }, [currentNodeId]);

  // Clear the multi-click tally on every node change. Without this,
  // `lastClickTime` survived the navigation and a press on the new
  // passage combined with one from the old.
  useEffect(() => {
    clickStateRef.current = resetClickState(clickStateRef.current);
  }, [currentNodeId]);

  const saveProgress = useCallback(
    (nodeId: string, hist: string[]) => {
      if (!story) return;
      // A review session leaves the listener's saves alone. Without
      // this, following a "Preview from here" link and advancing a
      // single passage overwrote their real autosave with the
      // reviewer's position — silently, and with no way back to it.
      if (!mayTouchSavedState()) return;
      const nextSlot: SaveSlot = {
        id: AUTOSAVE_SLOT_ID,
        name: 'Autosave',
        nodeId,
        history: hist,
        savedAt: new Date().toISOString(),
      };
      setSaveSlots((prev) => {
        const next = upsertSlot(prev, nextSlot);
        writeSlots(story.id, next);
        return next;
      });
    },
    [story, mayTouchSavedState],
  );

  const navigateToNode = useCallback(
    (nodeId: string, autoplay = true) => {
      if (!story?.nodes[nodeId]) return;
      const newHistory = currentNodeId ? [...history, currentNodeId] : history;
      setHistory(newHistory);
      // Update ref BEFORE pausing audio to prevent stale onpause handlers from firing
      currentNodeIdRef.current = nodeId;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      // follow-up: pause the indicator + choice refs too.
      // Earlier getCachedAudio cloned per visit, so an orphaned
      // playback was an unreachable temporary <audio>. Now those refs
      // point at the cache singletons — leaving them playing means the
      // previous node's prompt bleeds into the next node's voiceover.
      // We pause AND null the local ref: the cached <audio> singleton
      // stays in audioCacheRef so the next visit can reuse it (the
      // paused+rewound state is what getCachedAudio expects).
      for (const ref of [
        choice1IndicatorRef,
        choice2IndicatorRef,
        choice1AudioRef,
        choice2AudioRef,
      ]) {
        if (ref.current) {
          ref.current.pause();
          ref.current = null;
        }
      }
      if (choiceRepeatIntervalRef.current) {
        clearTimeout(choiceRepeatIntervalRef.current);
        choiceRepeatIntervalRef.current = null;
      }
      if (autoNavigateTimeoutRef.current) {
        clearTimeout(autoNavigateTimeoutRef.current);
        autoNavigateTimeoutRef.current = null;
      }
      if (audioRetryTimeoutRef.current) {
        clearTimeout(audioRetryTimeoutRef.current);
        audioRetryTimeoutRef.current = null;
      }
      if (prerollTimeoutRef.current) {
        clearTimeout(prerollTimeoutRef.current);
        prerollTimeoutRef.current = null;
      }
      if (connectionIssueTimeoutRef.current) {
        clearTimeout(connectionIssueTimeoutRef.current);
        connectionIssueTimeoutRef.current = null;
      }
      audioRetryCountRef.current = 0;
      setAudioError(null);
      setAudioSkipped(false);
      setAudioStalled(false);
      setRetryingAudio(false);
      setShowConnectionIssue(false);
      setCurrentNodeId(nodeId);
      setSelectedChoice(0);
      setAudioProgress(0);
      setAudioDuration(0);
      setPlayerState('ready');
      saveProgress(nodeId, newHistory);
      // Store nodeId for autoplay - the effect will pick this up
      if (autoplay) {
        pendingAutoplayNodeIdRef.current = nodeId;
      }

      // Progressive preload: preload audio for next reachable nodes
      const nearbyNodeIds = getReachableNodes(nodeId, story.nodes, 2);
      for (const nearbyId of nearbyNodeIds) {
        const node = story.nodes[nearbyId];
        if (node?.audio?.voiceover) {
          const key = 'vo_' + nearbyId;
          if (!isCached(key)) {
            preloadAudio(story.audioBaseUrl + node.audio.voiceover, key);
          }
        }
        if (node?.audio?.choice1) {
          const key = 'c1_' + nearbyId;
          if (!isCached(key)) {
            preloadAudio(story.audioBaseUrl + node.audio.choice1, key);
          }
        }
        if (node?.audio?.choice2) {
          const key = 'c2_' + nearbyId;
          if (!isCached(key)) {
            preloadAudio(story.audioBaseUrl + node.audio.choice2, key);
          }
        }
      }
    },
    [story, currentNodeId, history, saveProgress, getReachableNodes, preloadAudio],
  );

  const goBack = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    // Update ref BEFORE pausing to prevent stale handlers
    currentNodeIdRef.current = prev;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (choiceRepeatIntervalRef.current) {
      clearTimeout(choiceRepeatIntervalRef.current);
      choiceRepeatIntervalRef.current = null;
    }
    if (autoNavigateTimeoutRef.current) {
      clearTimeout(autoNavigateTimeoutRef.current);
      autoNavigateTimeoutRef.current = null;
    }
    if (audioRetryTimeoutRef.current) {
      clearTimeout(audioRetryTimeoutRef.current);
      audioRetryTimeoutRef.current = null;
    }
    if (prerollTimeoutRef.current) {
      clearTimeout(prerollTimeoutRef.current);
      prerollTimeoutRef.current = null;
    }
    setHistory((h) => h.slice(0, -1));
    setCurrentNodeId(prev);
    setSelectedChoice(0);
    setAudioError(null);
    setAudioSkipped(false);
    setPlayerState('ready');
  }, [history]);

  // Navigate to a target, handling END/DONE as terminal. Everything
  // else goes through resolveNodeReference (exact id → knot-qualified
  // → suffix match), which is what lets a bare stitch name on a choice
  // — the common shape when a story is imported from compiled
  // .ink.json — still find its passage instead of silently doing
  // nothing and leaving the player looking stuck.
  const navigateToTarget = useCallback(
    (target: string) => {
      if (target === 'END' || target === 'DONE') {
        setReachedEnding(true);
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current = null;
        }
        setPlayerState('ended');
        return;
      }
      if (!story) return;
      const resolved = resolveNodeReference(target, story.nodes, currentNodeIdRef.current);
      if (resolved) {
        navigateToNode(resolved);
        return;
      }
      // Truly missing target. Log + leave the player in its current
      // state so the choices remain available; the user can pick a
      // different one rather than getting stuck.

      console.warn('[wanderline] choice target not found in story graph', {
        target,
        currentKnot: currentNodeIdRef.current?.split('.')[0],
        knownNodes: Object.keys(story.nodes).length,
      });
    },
    [story, navigateToNode],
  );

  const playVoiceover = useCallback(() => {
    if (!story || !currentNode?.audio?.voiceover || !currentNodeId) return;
    setAudioError(null);
    setAudioSkipped(false);
    setAudioStalled(false);
    setRetryingAudio(false);

    // Every call to playVoiceover supersedes the one before it. The
    // async work started below (the looping choice sequence, retry
    // timers, auto-navigate) used to check only the captured node id,
    // which catches navigating AWAY but not starting over on the SAME
    // node. Re-entering the same node is the common case:
    // the on-screen play button did it on every tap, and every stall
    // retry does it too. The previous sequence sailed through its
    // guards and kept looping alongside the new one, each re-fetching
    // audio (getCachedAudio hands back a fresh element rather than
    // stomping a busy one), so listeners heard two or three files at
    // once and saw the story advance on its own from a stale timer.
    const epoch = ++playbackEpochRef.current;
    const isStale = () =>
      playbackEpochRef.current !== epoch || currentNodeIdRef.current !== currentNodeId;

    // A fresh start on this node begins at the beginning; only a retry
    // resumes. Without this reset, arriving at a new node would seek to
    // wherever the previous node happened to stall.
    if (audioRetryCountRef.current === 0) lastPositionRef.current = 0;

    // Clear any pending retry or pre-roll timeout from a prior call to
    // playVoiceover so they can't race with the new audio element.
    if (audioRetryTimeoutRef.current) {
      clearTimeout(audioRetryTimeoutRef.current);
      audioRetryTimeoutRef.current = null;
    }
    if (prerollTimeoutRef.current) {
      clearTimeout(prerollTimeoutRef.current);
      prerollTimeoutRef.current = null;
    }
    // A pending auto-navigate from the previous attempt has to go too.
    // It was the one timer playVoiceover never cleared, so a retry part
    // way through a passage could still fire the old jump and move the
    // listener on without input.
    if (autoNavigateTimeoutRef.current) {
      clearTimeout(autoNavigateTimeoutRef.current);
      autoNavigateTimeoutRef.current = null;
    }

    if (audioRef.current) audioRef.current.pause();

    // Clear any existing choice audio repeat interval
    if (choiceRepeatIntervalRef.current) {
      clearTimeout(choiceRepeatIntervalRef.current);
      choiceRepeatIntervalRef.current = null;
    }

    // Stop choice + indicator audio before re-fetching it below.
    // getCachedAudio clones any element that is mid-playback instead of
    // interrupting it, so without this the outgoing sequence's clips
    // keep sounding underneath the new ones.
    for (const ref of [
      choice1AudioRef,
      choice2AudioRef,
      choice1IndicatorRef,
      choice2IndicatorRef,
    ]) {
      ref.current?.pause();
    }

    // Reset played indicators state
    playedIndicatorsRef.current = { choice1: false, choice2: false };

    // Use cached indicator audio elements if available
    const indicatorVol = userIndicatorVolume / 100;
    if (story.indicatorAudio?.choice1) {
      const url = story.audioBaseUrl + story.indicatorAudio.choice1;
      choice1IndicatorRef.current = getCachedAudio('ind_c1', url);
      choice1IndicatorRef.current.volume = indicatorVol;
    }
    if (story.indicatorAudio?.choice2) {
      const url = story.audioBaseUrl + story.indicatorAudio.choice2;
      choice2IndicatorRef.current = getCachedAudio('ind_c2', url);
      choice2IndicatorRef.current.volume = indicatorVol;
    }

    // Use cached choice audio elements
    if (currentNode.audio?.choice1) {
      const url = story.audioBaseUrl + currentNode.audio.choice1;
      choice1AudioRef.current = getCachedAudio('c1_' + currentNodeId, url);
    }
    if (currentNode.audio?.choice2) {
      const url = story.audioBaseUrl + currentNode.audio.choice2;
      choice2AudioRef.current = getCachedAudio('c2_' + currentNodeId, url);
    }

    // Stale callbacks are handled by isStale() above, which covers both
    // the captured node id and the playback epoch.
    const audioUrl = story.audioBaseUrl + currentNode.audio.voiceover;
    // Use cached voiceover audio if available
    const audio = getCachedAudio('vo_' + currentNodeId, audioUrl);
    audio.volume = voiceoverVolume / 100;
    audio.onloadstart = () => {
      if (!isStale()) setPlayerState('loading');
    };
    audio.oncanplay = () => {
      // Don't flip the player state to 'playing' while a delayBeforeMs
      // pre-roll is still pending — `oncanplay` can fire as soon as a
      // cached audio element is ready, well before we actually call
      // .play(). Without this guard, the UI would claim "playing"
      // during the silent pre-roll.
      if (!isStale() && !prerollTimeoutRef.current) {
        setPlayerState('playing');
        setAudioError(null);
      }
    };
    audio.onplay = () => {
      if (!isStale()) setPlayerState('playing');
    };
    audio.onpause = () => {
      if (!isStale()) setPlayerState('paused');
    };
    audio.onended = () => {
      // Check if we're still on the same node - if not, ignore this callback
      if (isStale()) return;
      setPlayerState('ended');

      // Auto-continue: if only one choice and autoContinue enabled,
      // navigate automatically. Through the resolver like every other
      // way forward — an exact-id gate here meant a single-choice
      // passage whose target is a bare stitch name fell through into
      // the choice-audio loop instead of continuing.
      const soleChoice = currentNode.choices?.length === 1 ? currentNode.choices[0] : null;
      if (
        autoContinue &&
        soleChoice &&
        resolveNodeReference(soleChoice.target, story.nodes, currentNodeId)
      ) {
        autoNavigateTimeoutRef.current = setTimeout(
          () => navigateToTargetRef.current?.(soleChoice.target),
          story.settings?.choiceAudioDelayMs ?? 3000,
        );
        return;
      }

      // If node has choices with audio, start repeating choice sequence
      const hasChoiceAudio = choice1AudioRef.current || choice2AudioRef.current;
      if (currentNode.choices?.length > 0 && hasChoiceAudio) {
        // Play sequence: wait (configurable) -> indicator1 -> choice1 -> indicator2 -> choice2 -> wait 2s -> repeat
        const playAudio = (audioEl: HTMLAudioElement | null): Promise<void> => {
          return new Promise((resolve) => {
            if (!audioEl) {
              resolve();
              return;
            }
            try {
              audioEl.currentTime = 0;
            } catch {
              // Evicted buffer on cached element — let play() refetch.
            }
            // { once: true } so the listener self-removes whether ended
            // fires or not's-then-something-else clears the audio. Without
            // this, getCachedAudio's reuse path would accumulate
            // dangling 'ended' listeners on the cached element across
            // every revisit when audio.play() rejects (caught below)
            // never fires `ended`.
            audioEl.addEventListener('ended', () => resolve(), { once: true });
            audioEl.play().catch(() => resolve());
          });
        };

        const delay = (ms: number): Promise<void> =>
          new Promise((resolve) => setTimeout(resolve, ms));

        const runChoiceSequence = async () => {
          if (isStale()) return;
          // Wait before starting choice audio (default 3 seconds)
          await delay(story.settings?.choiceAudioDelayMs ?? 3000);
          if (isStale()) return;
          // Choice 1: indicator then audio
          await playAudio(choice1IndicatorRef.current);
          if (isStale()) return;
          await playAudio(choice1AudioRef.current);
          if (isStale()) return;
          // Choice 2: indicator then audio (if exists)
          if (choice2AudioRef.current || choice2IndicatorRef.current) {
            await playAudio(choice2IndicatorRef.current);
            if (isStale()) return;
            await playAudio(choice2AudioRef.current);
            if (isStale()) return;
          }
          // A passage with only one way forward and auto-advance on
          // plays its cue ONCE and then moves on. Repeating it would
          // loop forever on a passage that has no decision to wait for,
          // and this branch runs before the auto-advance one — so
          // without this, a single-choice passage that happens to have
          // a choice cue would never advance at all.
          const onward = autoAdvanceTarget(
            currentNode,
            { autoAdvance: autoAdvanceRef.current },
            story.nodes,
          );
          if (onward) {
            // Same hold as the no-cue branch below, so two passages
            // configured identically pace identically whether or not
            // one happens to have a cue file.
            autoNavigateTimeoutRef.current = setTimeout(
              () => navigateToTargetRef.current?.(onward),
              (currentNode.metadata?.delayAfterMs ?? 0) +
                (currentNode.metadata?.autoAdvanceDelayMs ?? 2000),
            );
            return;
          }
          // Otherwise the listener still has a choice to make: keep
          // offering it.
          choiceRepeatIntervalRef.current = setTimeout(runChoiceSequence, 2000);
        };

        // Start the sequence
        runChoiceSequence();
      } else if (
        autoAdvanceTarget(currentNode, { autoAdvance: autoAdvanceRef.current }, story.nodes)
      ) {
        const target = autoAdvanceTarget(
          currentNode,
          { autoAdvance: autoAdvanceRef.current },
          story.nodes,
        )!;
        // Total post-audio hold = the per-node delayAfterMs (a generic
        // "wait after audio finishes" hint) plus the dedicated
        // autoAdvanceDelayMs (how long the listener has to react to
        // the end of narration before we navigate).
        const postAudioHoldMs =
          (currentNode.metadata?.delayAfterMs ?? 0) +
          (currentNode.metadata?.autoAdvanceDelayMs ?? 2000);
        autoNavigateTimeoutRef.current = setTimeout(
          () => navigateToTargetRef.current?.(target),
          postAudioHoldMs,
        );
      }
    };
    audio.ontimeupdate = () => {
      setAudioProgress(audio.currentTime);
      setAudioDuration(audio.duration || 0);
      // Remember how far the narration actually got. A retry rebuilds
      // the element through getCachedAudio, which rewinds to 0, so
      // without this a stall part way through a passage restarted it
      // from the top and the listener heard the opening again.
      lastPositionRef.current = audio.currentTime;

      // Play choice indicator audio at specified timestamps
      const currentTimeMs = audio.currentTime * 1000;
      const choice1Time = currentNode.metadata?.choice1TimestampMs;
      const choice2Time = currentNode.metadata?.choice2TimestampMs;

      if (choice1Time && !playedIndicatorsRef.current.choice1 && currentTimeMs >= choice1Time) {
        playedIndicatorsRef.current.choice1 = true;
        choice1IndicatorRef.current?.play().catch(() => {});
      }
      if (choice2Time && !playedIndicatorsRef.current.choice2 && currentTimeMs >= choice2Time) {
        playedIndicatorsRef.current.choice2 = true;
        choice2IndicatorRef.current?.play().catch(() => {});
      }
    };
    // Stall detection - audio is buffering
    audio.onwaiting = () => {
      if (isStale()) return;
      setAudioStalled(true);
    };
    audio.onplaying = () => {
      if (isStale()) return;
      setAudioStalled(false);
      setRetryingAudio(false);
      audioRetryCountRef.current = 0;
    };

    audio.onerror = () => {
      // Check if we're still on the same node
      if (isStale()) return;

      // Auto-retry up to 3 times before showing error
      if (audioRetryCountRef.current < 3) {
        audioRetryCountRef.current++;
        setRetryingAudio(true);
        setAudioStalled(false);
        const retryDelay = 1000 * audioRetryCountRef.current; // 1s, 2s, 3s
        audioRetryTimeoutRef.current = setTimeout(() => {
          if (!isStale()) {
            playVoiceover();
          }
        }, retryDelay);
        return;
      }

      // Max retries reached - show error
      const filename = currentNode.audio?.voiceover || 'unknown';
      console.error('[wanderline] audio load error', { file: filename, url: audioUrl });
      setAudioError('Audio could not be loaded - check your connection');
      setRetryingAudio(false);
      setPlayerState('ready');
    };

    const startPlayback = () => {
      // Clear the pre-roll ref now that we're proceeding so `oncanplay`
      // is allowed to flip the player state.
      prerollTimeoutRef.current = null;
      // Bail if the user navigated away before our pre-roll delay
      // elapsed.
      if (isStale()) return;
      // Pick up where the narration stopped. getCachedAudio rewinds
      // every element it hands back, so a retry would otherwise replay
      // the passage from the top: buffer part way through a long
      // passage and you hear the opening seconds again. Only on a
      // retry; a fresh visit to a node should start at the beginning.
      if (audioRetryCountRef.current > 0 && lastPositionRef.current > 0) {
        try {
          audio.currentTime = lastPositionRef.current;
        } catch {
          // Seeking can throw if the buffer was evicted. Starting over
          // is worse than nothing but still plays the passage.
        }
      }
      audio.play().catch((err) => {
        // Check if we're still on the same node
        if (isStale()) return;

        // Auto-retry on play failure (often happens with network issues)
        if (audioRetryCountRef.current < 3) {
          audioRetryCountRef.current++;
          setRetryingAudio(true);
          const retryDelay = 1000 * audioRetryCountRef.current;
          audioRetryTimeoutRef.current = setTimeout(() => {
            if (!isStale()) {
              playVoiceover();
            }
          }, retryDelay);
          return;
        }

        console.error('[wanderline] audio playback failed', err);
        setAudioError('Audio playback failed - check your connection');
        setRetryingAudio(false);
        setPlayerState('ready');
      });
    };
    // Honor the node's metadata.delayBeforeMs as a pre-roll pause
    // before the voiceover begins. Only on the first attempt — retries
    // recursively call playVoiceover and would otherwise re-apply the
    // delay every time, compounding network-induced waits. Uses a
    // dedicated ref (prerollTimeoutRef) so a concurrent retry timer
    // can't clobber it.
    const delayBeforeMs = currentNode.metadata?.delayBeforeMs ?? 0;
    const isRetry = audioRetryCountRef.current > 0;
    if (delayBeforeMs > 0 && !isRetry) {
      setPlayerState('loading');
      prerollTimeoutRef.current = setTimeout(startPlayback, delayBeforeMs);
    } else {
      startPlayback();
    }
    audioRef.current = audio;
  }, [
    story,
    currentNode,
    currentNodeId,
    autoContinue,
    getCachedAudio,
    voiceoverVolume,
    userIndicatorVolume,
  ]);

  const skipAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setAudioError(null);
    setAudioSkipped(true);
    setPlayerState('ended');
  }, []);

  // Auto-retry when coming back online
  useEffect(() => {
    const handleOnline = () => {
      // If we have an error or are stalled, retry playback
      if ((audioError || audioStalled) && currentNode?.audio?.voiceover) {
        audioRetryCountRef.current = 0; // Reset retry count
        setAudioError(null);
        setAudioStalled(false);
        playVoiceover();
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [audioError, audioStalled, currentNode, playVoiceover]);

  // No visibilitychange handler here on purpose. This is an audio-
  // narrative player, so listening through a lock screen or with the
  // app backgrounded (phone in pocket, screen off, Bluetooth in ear)
  // IS the primary use case. HTMLAudio + Media Session (see
  // useMediaControls) natively survives iOS backgrounding when the
  // page doesn't explicitly pause on document.hidden, so the correct
  // fix is to NOT fight the OS's default. An earlier version of this
  // component paused on hide to "unify desktop and mobile" — that
  // change is what caused the bug where BGM stopped on lock and
  // voice-over stopped when the tab wasn't focused.
  // Voiceover-less auto-advance: when the current node has no audio
  // there's no `audio.onended` to hook into, so the auto-advance path
  // inside playVoiceover is dead. Wire it up here so authors can use
  // silent transition nodes (a pure divert) with timing fields too.
  useEffect(() => {
    if (!story || !currentNode || !isAuthenticated || showInstructions) return;
    if (currentNode.audio?.voiceover) return; // handled by playVoiceover's audio.onended
    const target = autoAdvanceTarget(currentNode, { autoAdvance }, story.nodes);
    if (!target) return;
    // Compose: pre-roll → (no audio) → post-audio hold → onward.
    const totalDelay =
      (currentNode.metadata?.delayBeforeMs ?? 0) +
      (currentNode.metadata?.delayAfterMs ?? 0) +
      (currentNode.metadata?.autoAdvanceDelayMs ?? 2000);
    const t = setTimeout(() => {
      if (currentNodeIdRef.current !== currentNode.id) return;
      // navigateToTarget, not navigateToNode: a choice target may be
      // END/DONE (the parser's default when a choice has no divert) or
      // a bare stitch name needing knot qualification. navigateToNode
      // requires an exact id and silently does nothing otherwise, which
      // would leave the passage stalled with no timer to retry it.
      navigateToTargetRef.current?.(target);
    }, totalDelay);
    return () => clearTimeout(t);
  }, [story, currentNode, isAuthenticated, showInstructions, autoAdvance]);

  // Debounce showing connection issues to avoid flashing for quick retries
  useEffect(() => {
    const hasIssue = audioStalled || retryingAudio || audioError;
    if (hasIssue) {
      // Wait 800ms before showing connection issue UI
      connectionIssueTimeoutRef.current = setTimeout(() => {
        setShowConnectionIssue(true);
      }, 800);
    } else {
      // Clear immediately when resolved
      if (connectionIssueTimeoutRef.current) {
        clearTimeout(connectionIssueTimeoutRef.current);
        connectionIssueTimeoutRef.current = null;
      }
      setShowConnectionIssue(false);
    }
    return () => {
      if (connectionIssueTimeoutRef.current) {
        clearTimeout(connectionIssueTimeoutRef.current);
      }
    };
  }, [audioStalled, retryingAudio, audioError]);

  const restart = useCallback(() => {
    if (story) {
      // Normally a restart is a clean slate: the slots key goes,
      // manual saves and all.
      //
      // Not in a review session. Someone who followed a "Preview from
      // here" link into a story they were forty minutes through, and
      // tapped Restart to hear the passage again, would otherwise lose
      // every save they had for it — no confirmation, no way back.
      // Their saves are not this session's to delete; restart still
      // does what it says for THIS run, from the top.
      if (mayTouchSavedState()) {
        clearAllSlots(story.id);
        setSaveSlots([]);
      }
      setCurrentNodeId(story.startNode);
      setHistory([]);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setAudioError(null);
      setAudioSkipped(false);
      setReachedEnding(false);
      setPlayerState('ready');
      pendingAutoplayNodeIdRef.current = null;
    }
  }, [story, mayTouchSavedState]);

  // — save slot management. These operate against the slot
  // array in state, then persist via writeSlots(). They're stable
  // closures over `story` so the settings panel doesn't need to
  // re-render the full slots block on every keystroke.
  const loadSlot = useCallback(
    (slotId: string) => {
      if (!story) return;
      const slot = saveSlots.find((s) => s.id === slotId);
      if (!slot) return;
      if (!story.nodes[slot.nodeId]) return;
      // Jumping into a saved node — pause any current audio, clear
      // transient state, then swap the node + history wholesale.
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      pendingAutoplayNodeIdRef.current = null;
      // Picking a save is the listener saying "this is my run" — from
      // here on their progress is worth recording again, even if the
      // URL brought them in on a review link.
      protectSavesRef.current = false;
      setHistory(slot.history);
      setCurrentNodeId(slot.nodeId);
      setReachedEnding(false);
      setAudioError(null);
      setAudioSkipped(false);
      setShowSettings(false);
      setShowInstructions(false);
    },
    [story, saveSlots],
  );

  const saveCurrentToNewSlot = useCallback(
    (suggestedName?: string) => {
      if (!story || !currentNodeId) return;
      const name = (suggestedName || defaultManualSlotName(saveSlots)).trim() || 'Save';
      const slot: SaveSlot = {
        id: newSlotId(),
        name,
        nodeId: currentNodeId,
        history,
        savedAt: new Date().toISOString(),
      };
      setSaveSlots((prev) => {
        const next = upsertSlot(prev, slot);
        writeSlots(story.id, next);
        return next;
      });
    },
    [story, currentNodeId, history, saveSlots],
  );

  const deleteSlot = useCallback(
    (slotId: string) => {
      if (!story) return;
      setSaveSlots((prev) => {
        const next = removeSlot(prev, slotId);
        writeSlots(story.id, next);
        return next;
      });
    },
    [story],
  );

  const renameSlot = useCallback(
    (slotId: string, name: string) => {
      if (!story) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      setSaveSlots((prev) => {
        const next = prev.map((s) => (s.id === slotId ? { ...s, name: trimmed } : s));
        writeSlots(story.id, next);
        return next;
      });
    },
    [story],
  );

  // Start the story from instructions screen
  const startStory = useCallback(() => {
    setShowInstructions(false);
    startBackgroundMusic();
    // Auto-play first node after a short delay
    if (currentNode?.audio?.voiceover) {
      setTimeout(() => playVoiceover(), 300);
    }
  }, [startBackgroundMusic, currentNode, playVoiceover]);

  // Handle password submission
  const handlePasswordSubmit = useCallback(
    (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (!story?.settings?.password) return;
      if (passwordInput === story.settings.password) {
        setIsAuthenticated(true);
        setPasswordError(false);
        safeSetItem(sessionStorage, STORAGE_PREFIX + story.id + '_auth', 'true');
      } else {
        setPasswordError(true);
        setPasswordInput('');
      }
    },
    [story, passwordInput],
  );

  // Autoplay effect - triggers when node changes or instructions dismissed
  useEffect(() => {
    if (showInstructions) return; // Don't autoplay while showing instructions
    // Check if we have a pending autoplay request for this node
    const pendingNodeId = pendingAutoplayNodeIdRef.current;
    if (
      pendingNodeId &&
      pendingNodeId === currentNodeId &&
      currentNode?.audio?.voiceover &&
      playerState === 'ready'
    ) {
      pendingAutoplayNodeIdRef.current = null;
      // Small delay to ensure state is settled
      const timer = setTimeout(() => playVoiceover(), 100);
      return () => clearTimeout(timer);
    }
  }, [currentNodeId, showInstructions, currentNode, playerState, playVoiceover]);

  // Click handlers for headphone controls
  /**
   * The one place that decides what play/pause means.
   *
   * Pausing and resuming keeps the narration where it is; only a state
   * that has no live element to resume (loading, ended, errored) starts
   * the passage over. The headphone and keyboard paths went through
   * this logic while the on-screen button had its own two-way version
   * that called playVoiceover() whenever it was not already playing, so
   * the same pause resumed from the headphones and restarted from the
   * button. Sharing one callback means the two cannot drift again.
   */
  const togglePlayback = useCallback(() => {
    // Same 400ms staleness as the handlers above: by the time this
    // runs, narration may have ended. playerStateRef was written every
    // render and read nowhere, so a press captured while 'playing'
    // would pause an element that had already finished — a press that
    // appeared to do nothing.
    const state = playerStateRef.current;
    if (state === 'playing') audioRef.current?.pause();
    else if (state === 'paused') audioRef.current?.play().catch(() => {});
    else playVoiceover();
  }, [playVoiceover]);

  const handleSingleClick = useCallback(() => {
    if (showInstructions) {
      startStory();
      return;
    }
    togglePlayback();
  }, [showInstructions, startStory, togglePlayback]);

  // These run 400ms after the press that armed them, so they must read
  // the node through a ref. Closing over `currentNode` meant a press
  // made just before an auto-advance fired against the PREVIOUS node —
  // navigating from a passage the listener had already left, which
  // surfaces as the story jumping somewhere unrelated and audio playing
  // from a different node than the one on screen.
  //
  // useMediaControls already reads currentNodeRef for exactly this
  // reason ("so rapid headphone presses see the latest value, not the
  // closure-captured snapshot"); the click path never got the same
  // treatment, and currentNodeRef was written every render and read
  // nowhere in this file.
  const handleDoubleClick = useCallback(() => {
    const node = currentNodeRef.current;
    if (!story || !node) return;
    if (node.choices.length > 0) {
      const choice = node.choices[0];
      if (choice) navigateToTarget(choice.target);
    } else {
      // Not just `node.divert`: a fall-through passage is navigable and
      // these are the controls a listener has with the screen off.
      //
      // navigateToTarget, not navigateToNode: a divert can be END/DONE
      // or a bare stitch name needing knot qualification, and demanding
      // an exact id here meant the very reference shape the resolver
      // exists for auto-advanced fine but did nothing when pressed.
      const onward = node.divert ?? fallThroughTarget(node.id, node, story.nodes);
      if (onward) navigateToTarget(onward);
    }
  }, [story, navigateToTarget]);

  const handleTripleClick = useCallback(() => {
    const node = currentNodeRef.current;
    if (!story || !node) return;
    if (node.choices.length > 1) {
      const choice = node.choices[1];
      if (choice) navigateToTarget(choice.target);
    }
  }, [story, navigateToTarget]);

  const handleHeadphoneButtonPress = useCallback(() => {
    clickStateRef.current = processClick(clickStateRef.current, Date.now(), {
      onSingleClick: handleSingleClick,
      onDoubleClick: handleDoubleClick,
      onTripleClick: handleTripleClick,
    });
  }, [handleSingleClick, handleDoubleClick, handleTripleClick]);

  // Keep MediaSession callback refs pointed at the freshest closures.
  // Effect runs after every render with no deps so any change to the
  // upstream useCallbacks propagates immediately, while the binding
  // effect below stays anchored to story?.id.
  useEffect(() => {
    navigateToTargetRef.current = navigateToTarget;
    goBackRef.current = goBack;
    handleHeadphoneButtonPressRef.current = handleHeadphoneButtonPress;
  });

  useEffect(() => {
    if (!currentNode) return;
    const handleKey = (e: KeyboardEvent) => {
      // Ignore keyboard shortcuts while instructions or password screen is visible
      if (showInstructions || !isAuthenticated) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlayback();
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (currentNode.choices.length > 0) setSelectedChoice((c) => Math.max(0, c - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (currentNode.choices.length > 0)
            setSelectedChoice((c) => Math.min(currentNode.choices.length - 1, c + 1));
          break;
        case 'Enter':
          e.preventDefault();
          if (currentNode.choices.length > 0) {
            const choice = currentNode.choices[selectedChoice];
            if (choice) navigateToTarget(choice.target);
          } else {
            // Same resolver as every other way forward — see
            // handleDoubleClick for why an exact id isn't enough.
            const onward =
              currentNode.divert ??
              (story ? fallThroughTarget(currentNode.id, currentNode, story.nodes) : null);
            if (onward) navigateToTarget(onward);
          }
          break;
        case 'Backspace':
          e.preventDefault();
          goBack();
          break;
        case 'r':
        case 'R':
          // Restart from the start node, clearing history. Stops any
          // audio first so nothing keeps playing from the prior position.
          if (story?.startNode) {
            e.preventDefault();
            audioRef.current?.pause();
            setAudioError(null);
            setHistory([]);
            setSelectedChoice(0);
            setCurrentNodeId(story.startNode);
          }
          break;
        case 'Escape':
          // Dismiss the inline audio-error toast if one is showing. If
          // not, fall through to the skip-audio fallback below so users
          // have a single key for "get me unstuck".
          if (audioError) {
            e.preventDefault();
            skipAudio();
          }
          break;
        case 's':
        case 'S':
          if (audioError) {
            e.preventDefault();
            skipAudio();
          }
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [
    currentNode,
    story,
    playerState,
    selectedChoice,
    history,
    audioError,
    togglePlayback,
    navigateToTarget,
    skipAudio,
    goBack,
    showInstructions,
    isAuthenticated,
  ]);

  // MediaSession + keydown fallback + metadata /
  // playbackState mirroring all live inside useMediaControls. The
  // hook owns its own dedupe ref and the media-key sets; the refs
  // below are the always-latest closures the hook reads to avoid
  // rebinding on every navigation.
  useMediaControls({
    story,
    currentNode,
    showInstructions,
    isAuthenticated,
    playerState,
    startStory,
    handlers: {
      navigateToTargetRef,
      goBackRef,
      onHeadphoneButtonPressRef: handleHeadphoneButtonPressRef,
    },
    currentNodeRef,
    selectedChoiceRef,
    setSelectedChoice,
  });

  if (playerState === 'error' || !story) {
    return (
      <div style={styles.container}>
        <div style={styles.errorFull}>Failed to load story data</div>
      </div>
    );
  }

  if (!currentNode) return <div style={styles.container}>Loading...</div>;

  // Password protection screen
  if (story.settings?.password && !isAuthenticated) {
    return (
      <div style={styles.container}>
        <header style={styles.header} data-theme-component="header">
          <h1 style={styles.title}>{story?.title || 'Audio Story'}</h1>
        </header>
        <main
          style={{
            ...styles.main,
            justifyContent: 'center',
            alignItems: 'center',
            textAlign: 'center',
          }}
        >
          <div style={styles.passwordCard}>
            <h2 style={styles.passwordTitle}>Enter Password</h2>
            <p style={styles.passwordSubtitle}>This story is password protected</p>
            <form onSubmit={handlePasswordSubmit} style={styles.passwordForm}>
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => {
                  setPasswordInput(e.target.value);
                  setPasswordError(false);
                }}
                placeholder="Password"
                style={{
                  ...styles.passwordInput,
                  ...(passwordError ? styles.passwordInputError : {}),
                }}
                autoFocus
              />
              {passwordError && <p style={styles.passwordErrorText}>Incorrect password</p>}
              <button type="submit" style={styles.passwordBtn}>
                Enter
              </button>
            </form>
          </div>
        </main>
      </div>
    );
  }

  // The `?start=` notice describes where playback is ABOUT to begin.
  // The instructions overlay is re-openable mid-story from the header,
  // and Start Story resumes wherever the listener actually is — so once
  // they have moved on, the notice would be naming a passage they left,
  // directly contradicting the resume hint beside it. Show it only
  // while the player is still sitting where the parameter put it.
  const startNoticeApplies =
    startRequest !== null && currentNodeId === (startRequest.resolved ?? story.startNode);

  // Instructions screen
  if (showInstructions) {
    return (
      <div style={styles.container}>
        <header style={styles.header} data-theme-component="header">
          <h1 style={styles.title}>{story?.title || 'Audio Story'}</h1>
        </header>
        <main
          style={{
            ...styles.main,
            justifyContent: 'center',
            alignItems: 'center',
            textAlign: 'center',
          }}
          role="main"
          aria-label="Instructions"
        >
          <div
            style={styles.instructionsCard}
            role="region"
            aria-labelledby="instructions-title"
            data-theme-component="instructionsCard"
          >
            <h2 id="instructions-title" style={styles.instructionsTitle}>
              How to Navigate
            </h2>
            <ul style={styles.instructionsList} aria-label="Navigation instructions">
              <li style={styles.instructionItem}>
                <span style={styles.instructionIcon} className="wl-icon" aria-hidden="true">
                  <Play width={24} height={24} />
                </span>
                <div>
                  <strong>Play / Pause</strong>
                  <p style={styles.instructionText}>Tap once or press spacebar</p>
                </div>
              </li>
              <li style={styles.instructionItem}>
                <span style={styles.instructionIcon} className="wl-icon" aria-hidden="true">
                  <SkipNext width={24} height={24} />
                </span>
                <div>
                  <strong>Choice 1</strong>
                  <p style={styles.instructionText}>Double-tap or press Next Track</p>
                </div>
              </li>
              <li style={styles.instructionItem}>
                <span style={styles.instructionIcon} className="wl-icon" aria-hidden="true">
                  <SkipPrev width={24} height={24} />
                </span>
                <div>
                  <strong>Choice 2</strong>
                  <p style={styles.instructionText}>Triple-tap or press Previous Track</p>
                </div>
              </li>
            </ul>
            <div style={styles.volumePreview} role="group" aria-label="Volume settings">
              <h3 style={styles.volumePreviewTitle}>Volume Settings</h3>
              <div style={styles.volumePreviewRow}>
                <label htmlFor="intro-narration-volume" style={styles.volumePreviewLabel}>
                  Narration
                </label>
                <input
                  type="range"
                  id="intro-narration-volume"
                  min="0"
                  max="100"
                  value={voiceoverVolume}
                  onChange={(e) => setVoiceoverVolume(parseInt(e.target.value))}
                  style={styles.volumeSlider}
                  aria-label={'Narration volume ' + voiceoverVolume + ' percent'}
                />
                <span style={styles.volumePreviewValue}>{voiceoverVolume}%</span>
              </div>
              <div style={styles.volumePreviewRow}>
                <label htmlFor="intro-indicators-volume" style={styles.volumePreviewLabel}>
                  Indicators
                </label>
                <input
                  type="range"
                  id="intro-indicators-volume"
                  min="0"
                  max="100"
                  value={userIndicatorVolume}
                  onChange={(e) => setUserIndicatorVolume(parseInt(e.target.value))}
                  style={styles.volumeSlider}
                  aria-label={'Indicators volume ' + userIndicatorVolume + ' percent'}
                />
                <span style={styles.volumePreviewValue}>{userIndicatorVolume}%</span>
              </div>
              <div style={styles.volumePreviewRow}>
                <label htmlFor="intro-music-volume" style={styles.volumePreviewLabel}>
                  Music
                </label>
                <input
                  type="range"
                  id="intro-music-volume"
                  min="0"
                  max="100"
                  value={userBgMusicVolume}
                  onChange={(e) => setUserBgMusicVolume(parseInt(e.target.value))}
                  style={styles.volumeSlider}
                  aria-label={'Background music volume ' + userBgMusicVolume + ' percent'}
                />
                <span style={styles.volumePreviewValue}>{userBgMusicVolume}%</span>
              </div>
              <p style={styles.volumeHint}>
                <span style={styles.volumeHintIcon} className="wl-icon" aria-hidden="true">
                  <Settings width={14} height={14} />
                </span>{' '}
                You can also adjust these mid-story via the cog icon
              </p>
            </div>

            {/*: resume picker. Surfaces any save slot (autosave
                or manual) so listeners can pick where to start from.
                Hidden entirely when there are no slots so first-time
                users see the same Start Story button as before. */}
            {saveSlots.length > 0 && story && (
              <div
                style={styles.resumePicker}
                aria-label="Resume from a saved slot"
                data-theme-component="resumePicker"
              >
                <h3 style={styles.resumePickerTitle}>Resume from a save</h3>
                <ul style={styles.resumePickerList}>
                  {saveSlots.map((slot) => (
                    <li key={slot.id} style={styles.resumePickerRow}>
                      <button
                        type="button"
                        style={styles.resumePickerBtn}
                        onClick={() => loadSlot(slot.id)}
                        disabled={!story.nodes[slot.nodeId]}
                      >
                        <strong>{slot.name}</strong>
                        <span style={styles.resumePickerMeta}>
                          {new Date(slot.savedAt).toLocaleString()} · node {slot.nodeId}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {/* Read off where the session ACTUALLY begins, not off
                    the URL: this hint used to promise "the beginning"
                    to a listener whose autosave had already moved the
                    player forty minutes in, which is exactly the
                    disagreement resolveSessionStart exists to prevent. */}
                <p style={styles.resumePickerHint}>
                  Or use the Start Story button below to begin from{' '}
                  {currentNodeId && currentNodeId !== story.startNode
                    ? `passage ${currentNodeId}`
                    : 'the beginning'}
                  .
                </p>
              </div>
            )}

            {/* Where `?start=` landed us. A reviewer who followed
                "Preview from here" needs to see that the player agreed
                — and if the passage no longer exists (renamed, or the
                story was re-uploaded since the link was made), needs to
                be told rather than left wondering why the story sounds
                like the opening. */}
            {startRequest && startNoticeApplies && (
              <p style={styles.startNotice} role="status">
                {startRequest.resolved
                  ? `Starting from passage ${startRequest.resolved}.`
                  : `No passage matching "${startRequest.requested}" — starting from the beginning.`}
              </p>
            )}

            <button
              onClick={startStory}
              style={{
                ...styles.startBtn,
                ...(preloadState === 'loading' ? styles.startBtnLoading : {}),
              }}
              aria-label="Start the story"
              data-theme-component="startButton"
            >
              {preloadState === 'loading' ? (
                <>
                  <div style={styles.preloadSpinnerSmall} aria-hidden="true" />
                  Preparing...
                </>
              ) : (
                <>
                  <span style={styles.startBtnIcon} className="wl-icon" aria-hidden="true">
                    <Play width={20} height={20} />
                  </span>
                  Start Story
                </>
              )}
            </button>
          </div>
        </main>
      </div>
    );
  }

  // Ink's implicit continuation: a knot runs its first stitch, a stitch
  // continues into its next sibling. Not materialised by the parser, so
  // it has to be resolved here or a chapter's opening prose reads as
  // the end of the story.
  const fallThrough = story ? fallThroughTarget(currentNode.id, currentNode, story.nodes) : null;
  const isEnd =
    reachedEnding ||
    currentNode.tags.includes('ending') ||
    (currentNode.choices.length === 0 && !currentNode.divert && !fallThrough) ||
    currentNode.divert === 'END' ||
    currentNode.divert === 'DONE';

  return (
    <div
      style={styles.container}
      onClick={() => playerState === 'ready' && !audioError && playVoiceover()}
      role="application"
      aria-label={(story?.title || 'Audio Story') + ' - Audio Story'}
    >
      <OfflineControls support={offline} audioUrls={allAudioUrls} />
      <a
        href="#main-content"
        style={{
          position: 'absolute',
          left: '-9999px',
          top: 'auto',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
        }}
        onFocus={(e) =>
          (e.target.style.cssText =
            'position:fixed;top:10px;left:10px;padding:10px;background:#000;color:#fff;z-index:9999;')
        }
        onBlur={(e) => (e.target.style.cssText = 'position:absolute;left:-9999px;')}
      >
        Skip to content
      </a>
      <header style={styles.header} role="banner" data-theme-component="header">
        <div style={styles.headerRow}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCaptionsEnabled(!captionsEnabled);
            }}
            style={{ ...styles.headerBtn, ...(captionsEnabled ? styles.headerBtnActive : {}) }}
            aria-pressed={captionsEnabled}
            aria-label={
              captionsEnabled
                ? 'Captions enabled, click to disable'
                : 'Captions disabled, click to enable'
            }
          >
            CC
          </button>
          <h1 style={styles.title}>{story?.title || 'Audio Story'}</h1>
          <div style={styles.headerBtnGroup} role="toolbar" aria-label="Story controls">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowSettings(!showSettings);
              }}
              style={{ ...styles.headerBtn, ...(showSettings ? styles.headerBtnActive : {}) }}
              aria-pressed={showSettings}
              aria-expanded={showSettings}
              aria-label="Settings"
            >
              <Settings width={18} height={18} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (audioRef.current) {
                  audioRef.current.pause();
                  audioRef.current = null;
                }
                setShowInstructions(true);
              }}
              style={styles.headerBtn}
              aria-label="Help and instructions"
            >
              <ChatBubble width={18} height={18} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                restart();
              }}
              style={styles.headerBtn}
              aria-label="Restart story from beginning"
            >
              <Refresh width={18} height={18} />
            </button>
          </div>
        </div>
      </header>

      {showSettings && (
        <div
          style={styles.settingsPanel}
          data-theme-component="settingsPanel"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-labelledby="settings-title"
          aria-modal="false"
        >
          <h3 id="settings-title" style={styles.settingsTitle}>
            Settings
          </h3>
          <div style={styles.settingsCheckboxRow}>
            <input
              type="checkbox"
              id="auto-advance"
              checked={autoAdvance}
              onChange={(e) => chooseAutoAdvance(e.target.checked)}
              style={styles.settingsCheckbox}
              aria-describedby="auto-advance-hint"
            />
            {/* Label wraps the name only: a hint inside it would be
                read out as part of the control's name. */}
            <label htmlFor="auto-advance" style={styles.settingsCheckboxLabel}>
              Advance automatically
            </label>
            <span id="auto-advance-hint" style={styles.settingsCheckboxHint}>
              Moves on by itself where there is only one way forward. Passages that ask you to
              choose always wait for you.
            </span>
          </div>
          <div style={styles.settingsDivider} />
          <h4 style={styles.saveSlotsTitle}>Volume</h4>
          <div style={styles.settingsRow}>
            <label htmlFor="narration-volume" style={styles.settingsLabel}>
              Narration
            </label>
            <input
              type="range"
              id="narration-volume"
              min="0"
              max="100"
              value={voiceoverVolume}
              onChange={(e) => setVoiceoverVolume(parseInt(e.target.value))}
              style={styles.settingsSlider}
              aria-valuenow={voiceoverVolume}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={'Narration volume ' + voiceoverVolume + ' percent'}
            />
            <span style={styles.settingsValue} aria-hidden="true">
              {voiceoverVolume}%
            </span>
          </div>
          <div style={styles.settingsRow}>
            <label htmlFor="indicators-volume" style={styles.settingsLabel}>
              Indicators
            </label>
            <input
              type="range"
              id="indicators-volume"
              min="0"
              max="100"
              value={userIndicatorVolume}
              onChange={(e) => setUserIndicatorVolume(parseInt(e.target.value))}
              style={styles.settingsSlider}
              aria-valuenow={userIndicatorVolume}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={'Indicators volume ' + userIndicatorVolume + ' percent'}
            />
            <span style={styles.settingsValue} aria-hidden="true">
              {userIndicatorVolume}%
            </span>
          </div>
          <div style={styles.settingsRow}>
            <label htmlFor="music-volume" style={styles.settingsLabel}>
              Music
            </label>
            <input
              type="range"
              id="music-volume"
              min="0"
              max="100"
              value={userBgMusicVolume}
              onChange={(e) => setUserBgMusicVolume(parseInt(e.target.value))}
              style={styles.settingsSlider}
              aria-valuenow={userBgMusicVolume}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={'Background music volume ' + userBgMusicVolume + ' percent'}
            />
            <span style={styles.settingsValue} aria-hidden="true">
              {userBgMusicVolume}%
            </span>
          </div>
          {/*: save slot management */}
          <div style={styles.settingsDivider} />
          <div style={styles.saveSlotsHeader}>
            <h4 style={styles.saveSlotsTitle}>Save slots</h4>
            <button
              type="button"
              style={styles.saveSlotsNewBtn}
              onClick={() => {
                const suggested = defaultManualSlotName(saveSlots);
                const name = window.prompt('Name this save:', suggested);
                if (name !== null) saveCurrentToNewSlot(name);
              }}
              aria-label="Save current progress to a new slot"
            >
              + New save
            </button>
          </div>
          {saveSlots.length === 0 ? (
            <p style={styles.saveSlotsEmpty}>No saves yet. Autosave kicks in as you play.</p>
          ) : (
            <ul style={styles.saveSlotsList} aria-label="Save slots">
              {saveSlots.map((slot) => (
                <li key={slot.id} style={styles.saveSlotRow}>
                  <div style={styles.saveSlotMeta}>
                    <strong style={styles.saveSlotName}>{slot.name}</strong>
                    <span style={styles.saveSlotTime}>
                      {new Date(slot.savedAt).toLocaleString()}
                    </span>
                  </div>
                  <div style={styles.saveSlotActions}>
                    <button
                      type="button"
                      style={styles.saveSlotActionBtn}
                      onClick={() => loadSlot(slot.id)}
                      disabled={slot.nodeId === currentNodeId}
                    >
                      Load
                    </button>
                    {slot.id !== AUTOSAVE_SLOT_ID && (
                      <>
                        <button
                          type="button"
                          style={styles.saveSlotActionBtn}
                          onClick={() => {
                            const name = window.prompt('Rename save:', slot.name);
                            if (name !== null) renameSlot(slot.id, name);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          style={styles.saveSlotActionBtnDanger}
                          onClick={() => deleteSlot(slot.id)}
                          aria-label={`Delete ${slot.name}`}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <main id="main-content" style={styles.main} role="main" aria-label="Story content">
        <div aria-live="polite" aria-atomic="true" role="region" aria-label="Story narration">
          {captionsEnabled && (
            <article
              style={{
                ...styles.card,
                ...(currentNode.metadata?.theme && THEME_COLORS[currentNode.metadata.theme]
                  ? {
                      background: THEME_COLORS[currentNode.metadata.theme].bg,
                      borderLeft: `4px solid ${THEME_COLORS[currentNode.metadata.theme].border}`,
                    }
                  : {}),
              }}
              data-theme-component="storyCard"
            >
              {/* Treat whitespace-only legacy transcripts as "no
                  override" — otherwise earlier rows that contained
                  an accidental space rendered as blank paragraphs and
                  silently hid the Ink content fallback. */}
              {currentNode.metadata?.transcript?.trim() ? (
                <p
                  style={{
                    ...styles.text,
                    ...(currentNode.metadata?.theme && THEME_COLORS[currentNode.metadata.theme]
                      ? {
                          color: THEME_COLORS[currentNode.metadata.theme].text,
                        }
                      : {}),
                  }}
                >
                  {currentNode.metadata.transcript}
                </p>
              ) : (
                currentNode.content.map((c, i) => (
                  <p
                    key={i}
                    style={{
                      ...styles.text,
                      ...(currentNode.metadata?.theme && THEME_COLORS[currentNode.metadata.theme]
                        ? {
                            color: THEME_COLORS[currentNode.metadata.theme].text,
                          }
                        : {}),
                    }}
                  >
                    {c.text}
                  </p>
                ))
              )}
            </article>
          )}
        </div>

        {/* The row shows if EITHER control has something to offer. Back
            used to be trapped inside the audio-only condition, so a
            text-only passage — or one whose audio failed, which is
            exactly when someone wants to retreat — had no way back. */}
        {(history.length > 0 || (currentNode.audio?.voiceover && !audioError && !audioSkipped)) && (
          <div style={styles.player} role="group" aria-label="Playback controls">
            {/* goBack was reachable only by Backspace or a headphone
                button, so on a phone — the primary way this is listened
                to — there was no way back at all. Hidden rather than
                disabled at the start of the story: a control that never
                does anything is worse than one that isn't there. */}
            {history.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  goBack();
                }}
                style={styles.backBtn}
                data-theme-component="backButton"
                aria-label="Go back to the previous part"
              >
                <span aria-hidden="true">&#8592;</span>
              </button>
            )}
            {currentNode.audio?.voiceover && !audioError && !audioSkipped && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlayback();
                }}
                style={styles.playBtn}
                aria-label={
                  playerState === 'loading'
                    ? 'Loading audio'
                    : playerState === 'playing'
                      ? 'Pause narration'
                      : 'Play narration'
                }
              >
                <span aria-hidden="true">
                  {playerState === 'loading' ? '...' : playerState === 'playing' ? '||' : '>'}
                </span>
              </button>
            )}
            {currentNode.audio?.voiceover &&
              !audioError &&
              !audioSkipped &&
              story.settings?.showProgressBar !== false && (
                <div
                  style={styles.progress}
                  role="progressbar"
                  aria-valuenow={
                    audioDuration > 0 ? Math.round((audioProgress / audioDuration) * 100) : 0
                  }
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={
                    'Audio progress ' +
                    (audioDuration > 0 ? Math.round((audioProgress / audioDuration) * 100) : 0) +
                    ' percent'
                  }
                >
                  <div
                    style={{
                      ...styles.progressBar,
                      width: audioDuration > 0 ? `${(audioProgress / audioDuration) * 100}%` : '0%',
                    }}
                  />
                </div>
              )}
          </div>
        )}

        {currentNode.choices.length > 0 && story.settings?.showChoiceList !== false && (
          <nav
            style={styles.choices}
            role="navigation"
            aria-label="Story choices"
            data-theme-component="choiceButton"
          >
            {currentNode.choices.map((c, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  navigateToTarget(c.target);
                }}
                style={{ ...styles.choice, ...(i === selectedChoice ? styles.choiceSelected : {}) }}
                aria-label={'Choice ' + (i + 1) + ': ' + c.text}
                aria-current={i === selectedChoice ? 'true' : undefined}
              >
                {c.text}
              </button>
            ))}
          </nav>
        )}

        {(currentNode.divert || fallThrough) && currentNode.choices.length === 0 && !isEnd && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigateToTarget(currentNode.divert ?? fallThrough!);
            }}
            style={styles.continueBtn}
            aria-label="Continue to next part of the story"
          >
            Continue
          </button>
        )}

        {isEnd && (
          <div style={styles.end} role="status" aria-live="polite" aria-label="Story complete">
            The End
          </div>
        )}

        {/* Connection status - shown below content to avoid layout shift */}
        {showConnectionIssue && !audioError && (audioStalled || retryingAudio) && (
          <div style={styles.stalledBanner} role="status" aria-live="polite">
            <div style={styles.stalledSpinner} aria-hidden="true" />
            <span>{retryingAudio ? 'Reconnecting...' : 'Buffering...'}</span>
          </div>
        )}

        {showConnectionIssue && audioError && (
          <div
            style={styles.errorBanner}
            role="alert"
            aria-live="assertive"
            data-theme-component="errorBanner"
          >
            <span style={styles.errorIcon} className="wl-icon" aria-hidden="true">
              <WarningTriangle width={18} height={18} />
            </span>
            <div style={styles.errorContent}>
              <p style={styles.errorText}>{audioError}</p>
              <p style={styles.errorSubtext}>Will auto-retry when connection returns</p>
            </div>
            <div style={styles.errorActions}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  audioRetryCountRef.current = 0;
                  setShowConnectionIssue(false);
                  if (currentNodeId && currentNode?.audio?.voiceover) {
                    retryFailedAudio(
                      'vo_' + currentNodeId,
                      story.audioBaseUrl + currentNode.audio.voiceover,
                    );
                  }
                  playVoiceover();
                }}
                style={styles.retryBtn}
                aria-label="Retry playing audio"
              >
                Retry Now
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  skipAudio();
                }}
                style={styles.skipBtn}
                aria-label="Skip audio and continue with text"
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {audioSkipped && (
          <div style={styles.skippedBanner} role="status" aria-live="polite">
            Audio skipped - using text
          </div>
        )}
      </main>

      <footer style={styles.footer} role="contentinfo">
        Keyboard: Space/Arrows/Enter | Headphones: 1-tap Pause, 2-tap Choice 1, 3-tap Choice 2
      </footer>
    </div>
  );
}
