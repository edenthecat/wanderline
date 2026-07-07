import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useOfflineSupport } from './useOfflineSupport';
import { useMediaControls } from './useMediaControls';
import { useAudioCache } from './useAudioCache';
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

function createInitialClickState(): ClickDetectionState {
  return { clickCount: 0, lastClickTime: 0, timeoutId: null };
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
  const [voiceoverVolume, setVoiceoverVolume] = useState(100);
  const [userIndicatorVolume, setUserIndicatorVolume] = useState(50);
  const [userBgMusicVolume, setUserBgMusicVolume] = useState(100);
  const [autoContinue, setAutoContinue] = useState(true);
  const [reachedEnding, setReachedEnding] = useState(false);
  // multi-slot save state. `saveSlots` is sourced from
  // localStorage on story load (with legacy single-slot migration).
  // The autosave path writes into the slot with id="autosave"; manual
  // slots are created from the Save Slots panel.
  const [saveSlots, setSaveSlots] = useState<SaveSlot[]>([]);
  const [preloadState, setPreloadState] = useState<PreloadState>('idle');

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
  const navigateToNodeRef = useRef<((nodeId: string) => void) | null>(null);
  const goBackRef = useRef<(() => void) | null>(null);
  const handleHeadphoneButtonPressRef = useRef<(() => void) | null>(null);
  const clickStateRef = useRef<ClickDetectionState>(createInitialClickState());
  const pendingAutoplayNodeIdRef = useRef<string | null>(null);
  const choice1IndicatorRef = useRef<HTMLAudioElement | null>(null);
  const choice2IndicatorRef = useRef<HTMLAudioElement | null>(null);

  // Background music
  const bgMusicRef = useRef<HTMLAudioElement | null>(null);
  const bgMusicIndexRef = useRef(0);
  // remember which audio elements were playing when the tab
  // hid, so we can resume the same ones (and not, say, restart bgm
  // that the user had muted) when the tab regains focus.
  const wasPlayingBeforeHideRef = useRef<{ voice: boolean; bgm: boolean }>({
    voice: false,
    bgm: false,
  });
  const playedIndicatorsRef = useRef({ choice1: false, choice2: false });
  const choiceRepeatIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoNavigateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        const autosave = loadedSlots.find((s) => s.id === AUTOSAVE_SLOT_ID);
        // Auto-resume the autosave only when it diverges from the
        // start node — otherwise we'd surface a "Resume?" affordance
        // for a brand-new story that the user has only just opened.
        // If the user has manual slots saved, show the picker on the
        // instructions screen instead (handled in the JSX).
        if (autosave && autosave.nodeId !== data.startNode) {
          setCurrentNodeId(autosave.nodeId);
          setHistory(autosave.history);
        } else {
          setCurrentNodeId(data.startNode);
        }

        // Volume resolution order: per-device localStorage override
        // wins (the listener set it explicitly), otherwise the
        // project's author-chosen default from settings, otherwise
        // the hardcoded fallback.
        const s = (data.settings ?? {}) as {
          voiceoverVolume?: number;
          backgroundMusicVolume?: number;
          indicatorVolume?: number;
        };
        if (typeof s.voiceoverVolume === 'number') setVoiceoverVolume(s.voiceoverVolume);
        if (typeof s.indicatorVolume === 'number') setUserIndicatorVolume(s.indicatorVolume);
        if (typeof s.backgroundMusicVolume === 'number')
          setUserBgMusicVolume(s.backgroundMusicVolume);
        const savedVolumes = safeGetItem(localStorage, STORAGE_PREFIX + 'volumes');
        if (savedVolumes) {
          try {
            const volumes = JSON.parse(savedVolumes);
            if (volumes.voiceover !== undefined) setVoiceoverVolume(volumes.voiceover);
            if (volumes.indicator !== undefined) setUserIndicatorVolume(volumes.indicator);
            if (volumes.bgMusic !== undefined) setUserBgMusicVolume(volumes.bgMusic);
          } catch {}
        }
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

      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if (visited.has(id) || depth > maxDepth) continue;
        if (!nodes[id]) continue;

        visited.add(id);
        const node = nodes[id];

        // Add choices
        for (const choice of node.choices || []) {
          if (choice.target && choice.target !== 'END' && choice.target !== 'DONE') {
            queue.push({ id: choice.target, depth: depth + 1 });
          }
        }
        // Add divert
        if (node.divert && node.divert !== 'END' && node.divert !== 'DONE') {
          queue.push({ id: node.divert, depth: depth + 1 });
        }
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

    // Priority 2: First few reachable nodes (depth 2 = start node + 2 levels of choices)
    const nearbyNodeIds = getReachableNodes(story.startNode, story.nodes, 2);
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
  }, [story, preloadState, preloadAudio, getReachableNodes]);

  // Background music playback - independent of other audio and headphone controls
  const startBackgroundMusic = useCallback(() => {
    if (!story?.backgroundMusic?.length) return;
    if (bgMusicRef.current && !bgMusicRef.current.paused) return; // Already playing

    const playNextTrack = () => {
      if (!story.backgroundMusic?.length) return;

      const trackIndex = bgMusicIndexRef.current % story.backgroundMusic.length;
      const trackUrl = story.audioBaseUrl + story.backgroundMusic[trackIndex];
      const volume =
        (userBgMusicVolume / 100) * ((story.settings?.backgroundMusicVolume ?? 30) / 100);

      // Use cached audio if available
      const audio = getCachedAudio('bgm_' + trackIndex, trackUrl);
      audio.volume = volume;
      audio.loop = false;
      audio.onended = () => {
        bgMusicIndexRef.current = (bgMusicIndexRef.current + 1) % story.backgroundMusic!.length;
        playNextTrack();
      };
      audio.onerror = () => {
        // Skip to next track on error
        bgMusicIndexRef.current = (bgMusicIndexRef.current + 1) % story.backgroundMusic!.length;
        setTimeout(playNextTrack, 1000);
      };
      audio.play().catch(() => {});
      bgMusicRef.current = audio;
    };

    playNextTrack();
  }, [story, userBgMusicVolume, getCachedAudio]);

  // Cleanup background music on unmount
  useEffect(() => {
    return () => {
      if (bgMusicRef.current) {
        bgMusicRef.current.pause();
        bgMusicRef.current = null;
      }
    };
  }, []);

  // Save and apply volume settings
  useEffect(() => {
    safeSetItem(
      localStorage,
      STORAGE_PREFIX + 'volumes',
      JSON.stringify({
        voiceover: voiceoverVolume,
        indicator: userIndicatorVolume,
        bgMusic: userBgMusicVolume,
      }),
    );
    // Apply to currently playing audio
    if (audioRef.current) audioRef.current.volume = voiceoverVolume / 100;
    if (choice1IndicatorRef.current)
      choice1IndicatorRef.current.volume =
        (userIndicatorVolume / 100) * ((story?.settings?.indicatorVolume ?? 100) / 100);
    if (choice2IndicatorRef.current)
      choice2IndicatorRef.current.volume =
        (userIndicatorVolume / 100) * ((story?.settings?.indicatorVolume ?? 100) / 100);
    if (bgMusicRef.current)
      bgMusicRef.current.volume =
        (userBgMusicVolume / 100) * ((story?.settings?.backgroundMusicVolume ?? 30) / 100);
  }, [
    voiceoverVolume,
    userIndicatorVolume,
    userBgMusicVolume,
    story?.settings?.indicatorVolume,
    story?.settings?.backgroundMusicVolume,
  ]);

  const currentNode = story && currentNodeId ? story.nodes[currentNodeId] : null;

  // Every audio URL referenced by the story — used by the
  // "Download for offline" button to ask the service worker to
  // precache them in one pass. Deduped because background music
  // and indicators can repeat across many nodes. audioBaseUrl is
  // normalized to have exactly one trailing slash; the backend
  // emits both forms over the years.
  const allAudioUrls = useMemo<string[]>(() => {
    if (!story) return [];
    const urls = new Set<string>();
    const base = story.audioBaseUrl.replace(/\/?$/, '/');
    for (const file of story.backgroundMusic ?? []) urls.add(base + file);
    if (story.indicatorAudio?.choice1) urls.add(base + story.indicatorAudio.choice1);
    if (story.indicatorAudio?.choice2) urls.add(base + story.indicatorAudio.choice2);
    for (const node of Object.values(story.nodes)) {
      const a = node.audio;
      if (!a) continue;
      if (a.voiceover) urls.add(base + a.voiceover);
      if (a.choice1) urls.add(base + a.choice1);
      if (a.choice2) urls.add(base + a.choice2);
      if (a.ambience) urls.add(base + a.ambience);
    }
    return [...urls];
  }, [story]);

  // Keep MediaSession refs in sync with current state — handlers
  // installed once per story-id read these instead of closing over
  // stale values. Updating on every render is cheap and removes the
  // need to re-subscribe MediaSession handlers when selection or
  // playback state changes.
  selectedChoiceRef.current = selectedChoice;
  playerStateRef.current = playerState;
  currentNodeRef.current = currentNode;

  const saveProgress = useCallback(
    (nodeId: string, hist: string[]) => {
      if (!story) return;
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
    [story],
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

  // Navigate to a target, handling END/DONE as terminal.
  // If the target doesn't exactly match a node id, try resolving as
  // a relative-stitch reference: from inside knot "tell_you", a
  // choice with target "infinite_grace" should resolve to
  // "tell_you.infinite_grace". This is the common case when a story
  // is imported from compiled .ink.json where the source author
  // wrote `-> .infinite_grace` (relative divert) and the compiler
  // left the bare stitch name on the choice. Without this fallback,
  // clicking the choice silently does nothing and the player
  // appears stuck.
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
      if (story.nodes[target]) {
        navigateToNode(target);
        return;
      }
      // Try resolving target relative to the current node's knot
      // (everything before the first dot, or the node id itself if
      // there's no dot).
      const currentKnot = currentNodeIdRef.current?.split('.')[0];
      if (currentKnot) {
        const qualified = `${currentKnot}.${target}`;
        if (story.nodes[qualified]) {
          navigateToNode(qualified);
          return;
        }
      }
      // Last resort: any node that ends with `.target`. Picks the
      // first match — there should only be one in a well-formed
      // story; if not, the project's graph has a real bug worth
      // flagging in the editor, but for the player we'd rather
      // proceed than hang.
      const suffix = `.${target}`;
      for (const id of Object.keys(story.nodes)) {
        if (id.endsWith(suffix)) {
          navigateToNode(id);
          return;
        }
      }
      // Truly missing target. Log + leave the player in its current
      // state so the choices remain available; the user can pick a
      // different one rather than getting stuck.

      console.warn('[wanderline] choice target not found in story graph', {
        target,
        currentKnot,
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

    if (audioRef.current) audioRef.current.pause();

    // Clear any existing choice audio repeat interval
    if (choiceRepeatIntervalRef.current) {
      clearTimeout(choiceRepeatIntervalRef.current);
      choiceRepeatIntervalRef.current = null;
    }

    // Reset played indicators state
    playedIndicatorsRef.current = { choice1: false, choice2: false };

    // Use cached indicator audio elements if available
    const indicatorVol =
      (userIndicatorVolume / 100) * ((story.settings?.indicatorVolume ?? 100) / 100);
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

    // Capture the nodeId at audio creation time to handle stale callbacks
    const audioNodeId = currentNodeId;
    const audioUrl = story.audioBaseUrl + currentNode.audio.voiceover;
    // Use cached voiceover audio if available
    const audio = getCachedAudio('vo_' + currentNodeId, audioUrl);
    audio.volume = voiceoverVolume / 100;
    audio.onloadstart = () => {
      if (currentNodeIdRef.current === audioNodeId) setPlayerState('loading');
    };
    audio.oncanplay = () => {
      // Don't flip the player state to 'playing' while a delayBeforeMs
      // pre-roll is still pending — `oncanplay` can fire as soon as a
      // cached audio element is ready, well before we actually call
      // .play(). Without this guard, the UI would claim "playing"
      // during the silent pre-roll.
      if (currentNodeIdRef.current === audioNodeId && !prerollTimeoutRef.current) {
        setPlayerState('playing');
        setAudioError(null);
      }
    };
    audio.onplay = () => {
      if (currentNodeIdRef.current === audioNodeId) setPlayerState('playing');
    };
    audio.onpause = () => {
      if (currentNodeIdRef.current === audioNodeId) setPlayerState('paused');
    };
    audio.onended = () => {
      // Check if we're still on the same node - if not, ignore this callback
      if (currentNodeIdRef.current !== audioNodeId) return;
      setPlayerState('ended');

      // Auto-continue: if only one choice and autoContinue enabled, navigate automatically
      if (
        autoContinue &&
        currentNode.choices?.length === 1 &&
        story.nodes[currentNode.choices[0].target]
      ) {
        autoNavigateTimeoutRef.current = setTimeout(
          () => navigateToNode(currentNode.choices[0].target),
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
          if (currentNodeIdRef.current !== audioNodeId) return;
          // Wait before starting choice audio (default 3 seconds)
          await delay(story.settings?.choiceAudioDelayMs ?? 3000);
          if (currentNodeIdRef.current !== audioNodeId) return;
          // Choice 1: indicator then audio
          await playAudio(choice1IndicatorRef.current);
          if (currentNodeIdRef.current !== audioNodeId) return;
          await playAudio(choice1AudioRef.current);
          if (currentNodeIdRef.current !== audioNodeId) return;
          // Choice 2: indicator then audio (if exists)
          if (choice2AudioRef.current || choice2IndicatorRef.current) {
            await playAudio(choice2IndicatorRef.current);
            if (currentNodeIdRef.current !== audioNodeId) return;
            await playAudio(choice2AudioRef.current);
            if (currentNodeIdRef.current !== audioNodeId) return;
          }
          // Wait 2 seconds then repeat
          choiceRepeatIntervalRef.current = setTimeout(runChoiceSequence, 2000);
        };

        // Start the sequence
        runChoiceSequence();
      } else if (
        // Default is "auto-advance on" — only an explicit false opts
        // out. Keeps the editor's `?? true` default consistent with
        // what the runtime does for legacy nodes that have no row.
        currentNode.metadata?.autoAdvance !== false &&
        currentNode.divert &&
        story.nodes[currentNode.divert]
      ) {
        // Total post-audio hold = the per-node delayAfterMs (a generic
        // "wait after audio finishes" hint) plus the dedicated
        // autoAdvanceDelayMs (how long the listener has to react to
        // the end of narration before we navigate).
        const postAudioHoldMs =
          (currentNode.metadata?.delayAfterMs ?? 0) +
          (currentNode.metadata?.autoAdvanceDelayMs ?? 2000);
        autoNavigateTimeoutRef.current = setTimeout(
          () => navigateToNode(currentNode.divert!),
          postAudioHoldMs,
        );
      }
    };
    audio.ontimeupdate = () => {
      setAudioProgress(audio.currentTime);
      setAudioDuration(audio.duration || 0);

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
      if (currentNodeIdRef.current !== audioNodeId) return;
      setAudioStalled(true);
    };
    audio.onplaying = () => {
      if (currentNodeIdRef.current !== audioNodeId) return;
      setAudioStalled(false);
      setRetryingAudio(false);
      audioRetryCountRef.current = 0;
    };

    audio.onerror = () => {
      // Check if we're still on the same node
      if (currentNodeIdRef.current !== audioNodeId) return;

      // Auto-retry up to 3 times before showing error
      if (audioRetryCountRef.current < 3) {
        audioRetryCountRef.current++;
        setRetryingAudio(true);
        setAudioStalled(false);
        const retryDelay = 1000 * audioRetryCountRef.current; // 1s, 2s, 3s
        audioRetryTimeoutRef.current = setTimeout(() => {
          if (currentNodeIdRef.current === audioNodeId) {
            playVoiceover();
          }
        }, retryDelay);
        return;
      }

      // Max retries reached - show error
      const filename = currentNode.audio?.voiceover || 'unknown';
      console.error('Audio load error:', { file: filename, url: audioUrl });
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
      if (currentNodeIdRef.current !== audioNodeId) return;
      audio.play().catch((err) => {
        // Check if we're still on the same node
        if (currentNodeIdRef.current !== audioNodeId) return;

        // Auto-retry on play failure (often happens with network issues)
        if (audioRetryCountRef.current < 3) {
          audioRetryCountRef.current++;
          setRetryingAudio(true);
          const retryDelay = 1000 * audioRetryCountRef.current;
          audioRetryTimeoutRef.current = setTimeout(() => {
            if (currentNodeIdRef.current === audioNodeId) {
              playVoiceover();
            }
          }, retryDelay);
          return;
        }

        console.error('Audio playback failed:', err);
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
    navigateToNode,
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

  // Pause / resume playback when the tab is hidden (phone
  // calls, notifications, browser switching apps). The browser pauses
  // audio on iOS when the tab goes background, but on desktop it
  // keeps playing — neither matches what a listener wants. Unified
  // behavior: explicit pause-on-hide, resume-on-show, but ONLY for
  // playback we initiated (so we don't fight a user who paused
  // manually and then tabbed away).
  useEffect(() => {
    const handleVisibilityChange = () => {
      const audio = audioRef.current;
      const bgm = bgMusicRef.current;
      if (document.hidden) {
        // Remember what was playing so we can resume the same things.
        wasPlayingBeforeHideRef.current = {
          voice: !!audio && !audio.paused,
          bgm: !!bgm && !bgm.paused,
        };
        try {
          audio?.pause();
        } catch {}
        try {
          bgm?.pause();
        } catch {}
      } else {
        const prev = wasPlayingBeforeHideRef.current;
        wasPlayingBeforeHideRef.current = { voice: false, bgm: false };
        if (prev.voice && audio) audio.play().catch(() => {});
        if (prev.bgm && bgm) bgm.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Voiceover-less auto-advance: when the current node has no audio
  // there's no `audio.onended` to hook into, so the auto-advance path
  // inside playVoiceover is dead. Wire it up here so authors can use
  // silent transition nodes (a pure divert) with timing fields too.
  useEffect(() => {
    if (!story || !currentNode || !isAuthenticated || showInstructions) return;
    if (currentNode.audio?.voiceover) return; // handled by playVoiceover's audio.onended
    if (currentNode.metadata?.autoAdvance === false) return;
    if (!currentNode.divert || !story.nodes[currentNode.divert]) return;
    // Compose: pre-roll → (no audio) → post-audio hold → divert.
    const totalDelay =
      (currentNode.metadata?.delayBeforeMs ?? 0) +
      (currentNode.metadata?.delayAfterMs ?? 0) +
      (currentNode.metadata?.autoAdvanceDelayMs ?? 2000);
    const target = currentNode.divert;
    const t = setTimeout(() => {
      if (currentNodeIdRef.current !== currentNode.id) return;
      navigateToNode(target);
    }, totalDelay);
    return () => clearTimeout(t);
  }, [story, currentNode, navigateToNode, isAuthenticated, showInstructions]);

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
      // also wipe the new slots key. Manual saves get removed
      // alongside the autosave so a "restart" is a clean slate.
      clearAllSlots(story.id);
      setSaveSlots([]);
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
  }, [story]);

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
  const handleSingleClick = useCallback(() => {
    if (showInstructions) {
      startStory();
      return;
    }
    if (playerState === 'playing') audioRef.current?.pause();
    else if (playerState === 'paused') audioRef.current?.play();
    else playVoiceover();
  }, [showInstructions, startStory, playerState, playVoiceover]);

  const handleDoubleClick = useCallback(() => {
    if (!story || !currentNode) return;
    if (currentNode.choices.length > 0) {
      const choice = currentNode.choices[0];
      if (choice) navigateToTarget(choice.target);
    } else if (currentNode.divert && story.nodes[currentNode.divert]) {
      navigateToNode(currentNode.divert);
    }
  }, [story, currentNode, navigateToNode]);

  const handleTripleClick = useCallback(() => {
    if (!story || !currentNode) return;
    if (currentNode.choices.length > 1) {
      const choice = currentNode.choices[1];
      if (choice) navigateToTarget(choice.target);
    }
  }, [story, currentNode, navigateToNode]);

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
    navigateToNodeRef.current = navigateToNode;
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
          if (playerState === 'playing') audioRef.current?.pause();
          else if (playerState === 'paused') audioRef.current?.play();
          else playVoiceover();
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
          } else if (currentNode.divert && story?.nodes[currentNode.divert]) {
            navigateToNode(currentNode.divert);
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
    playVoiceover,
    navigateToNode,
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
      navigateToNodeRef,
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
              <div style={styles.introSettingsDivider} />
              <label style={styles.introCheckboxRow}>
                <input
                  type="checkbox"
                  checked={autoContinue}
                  onChange={(e) => setAutoContinue(e.target.checked)}
                  style={styles.introCheckbox}
                />
                <div>
                  <span style={styles.introCheckboxLabel}>Auto-continue</span>
                  <p style={styles.introCheckboxHint}>
                    Automatically proceed when there&apos;s only one choice
                  </p>
                </div>
              </label>
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
                <p style={styles.resumePickerHint}>
                  Or use the Start Story button below to begin from the beginning.
                </p>
              </div>
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

  const isEnd =
    reachedEnding ||
    currentNode.tags.includes('ending') ||
    (currentNode.choices.length === 0 && !currentNode.divert) ||
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
            Volume Settings
          </h3>
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
          <div style={styles.settingsDivider} />
          <label style={styles.settingsCheckboxRow}>
            <input
              type="checkbox"
              checked={autoContinue}
              onChange={(e) => setAutoContinue(e.target.checked)}
              style={styles.settingsCheckbox}
            />
            <span style={styles.settingsCheckboxLabel}>Auto-continue</span>
            <span style={styles.settingsCheckboxHint}>Skip choice audio when only one option</span>
          </label>

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

        {currentNode.audio?.voiceover && !audioError && !audioSkipped && (
          <div style={styles.player} role="group" aria-label="Audio player">
            <button
              onClick={(e) => {
                e.stopPropagation();
                playerState === 'playing' ? audioRef.current?.pause() : playVoiceover();
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
            {story.settings?.showProgressBar !== false && (
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

        {currentNode.divert && currentNode.choices.length === 0 && !isEnd && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigateToTarget(currentNode.divert!);
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
