// Shared settings access for the per-section tools (Volumes, System
// sounds, Headphone controls, Player display, plus the trimmed-down
// Settings page for Password + Danger zone). Each section was its
// own block of state-and-PATCH code inside SettingsTab; pulling it
// here keeps the PATCH protocol consistent across the new tools
// (optimistic update, key-scoped rollback on failure).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { fetchProjectSettings, updateProjectSettings, type ProjectSettings } from '../api/client';
import { bumpLiveSignal, PROJECT_SETTINGS_SIGNAL } from './useLiveSignal';

// Same-tab fanout for "project settings just changed".
//
// bumpLiveSignal deliberately ignores its own doc's local writes (the
// writer has already refreshed itself), and it needs a live collab doc
// — neither of which covers the case that bites here: the tabs in
// ProjectDetailPage are mutually exclusive, so releasing a volume
// slider and clicking the Story tab unmounts this hook and mounts
// useNodeEditor's settings fetch in the same commit. The flushed PATCH
// and that GET then race, and if the GET wins, the node panel mixes at
// — and displays — the volume the author just moved away from, with
// nothing to correct it. A module-level tick reaches the new tab
// whether or not a doc survived the switch.
let settingsTick = 0;
const settingsListeners = new Set<() => void>();

/** Returns the new tick so a publisher can recognise its own bump and
 *  skip re-reading what it already has. */
function bumpProjectSettingsTick(): number {
  settingsTick += 1;
  for (const notify of [...settingsListeners]) notify();
  return settingsTick;
}

/** Re-renders on any project-settings save made in THIS tab. Pair it
 *  with the PROJECT_SETTINGS_SIGNAL live signal, which covers peers. */
export function useProjectSettingsTick(): number {
  return useSyncExternalStore(
    (onChange) => {
      settingsListeners.add(onChange);
      return () => {
        settingsListeners.delete(onChange);
      };
    },
    () => settingsTick,
    () => settingsTick,
  );
}

export interface UseProjectSettingsResult {
  settings: ProjectSettings | null;
  loading: boolean;
  error: string | null;
  setError: (s: string | null) => void;
  /**
   * PATCH a single key. Updates local state optimistically; on
   * failure rolls back JUST that key if the user hasn't changed it
   * again in the meantime. Concurrent calls with different keys are
   * independent.
   */
  updateOne: <K extends keyof ProjectSettings>(key: K, next: ProjectSettings[K]) => Promise<void>;
  /**
   * Like updateOne but debounces the PATCH 250ms — for sliders that
   * fire onChange every pixel of movement.
   */
  updateDebounced: <K extends keyof ProjectSettings>(key: K, next: ProjectSettings[K]) => void;
  /**
   * Reset the local state from the server. Useful after a section
   * deletes / regenerates project data.
   */
  reload: () => Promise<void>;
}

/**
 * @param yDoc optional collab doc. When passed, a successful save
 * tells peers to re-read settings — without it a change here reaches
 * other people's open tabs only when they remount. That matters for
 * volumes: the node panel mixes at them, so a stale copy is a mix
 * that is silently not what the author set.
 */
export function useProjectSettings(
  projectId: string,
  yDoc: Y.Doc | null = null,
): UseProjectSettingsResult {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // The tick value this instance has already accounted for. Seeded from
  // the current tick so mounting never triggers a redundant re-read,
  // and advanced by our own saves so we don't chase our own tail.
  const tick = useProjectSettingsTick();
  const handledTickRef = useRef(tick);
  // What each pending debounce is going to save, so a teardown can
  // finish the work instead of dropping it.
  const pendingSavesRef = useRef<Map<string, unknown>>(new Map());

  /** `quiet` re-reads without flipping `loading` — a peer's save
   *  shouldn't blank a section the author is looking at. */
  async function reload(quiet = false) {
    if (!quiet) setLoading(true);
    try {
      const { settings: data } = await fetchProjectSettings(projectId);
      setSettings(data);
      setError(null);
    } catch (err) {
      if (!quiet) setSettings({});
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    setError(null);
    setLoading(true);
    reload();
    // Read the refs here rather than in the cleanup: both hold a Map
    // that is never reassigned, so it is the same object either way,
    // and the lint rule that warns about refs-in-cleanup is right to
    // insist the closure not depend on that being true.
    const timers = debounceTimersRef.current;
    const pending = pendingSavesRef.current;
    // FLUSH pending debounced saves on the way out — don't drop them.
    // These sections are conditionally rendered, so releasing a slider
    // and clicking another tab within the debounce window used to lose
    // the change silently: no error, and the optimistic value died with
    // the component, so the slider had quietly reverted on return. A
    // dropped volume is worse than a dropped preference now that the
    // node panel auditions passages at these numbers.
    //
    // `projectId` here is the one this effect ran for, which is what a
    // project switch needs to save against. No live signal on this
    // path: peers matter less than the save landing, and the collab
    // doc may be torn down alongside us.
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      if (pending.size > 0) {
        const patch = Object.fromEntries(pending) as Partial<ProjectSettings>;
        pending.clear();
        // This component is gone, so there is no local state to
        // update — but the tab replacing it may already have read the
        // pre-flush settings, and so may a collaborator, so both still
        // have to be told. The doc is captured here rather than read
        // later: ProjectDetailPage holds the ref-counted entry for the
        // whole page, so a tab switch doesn't destroy it, but a full
        // project switch does and a bump then is a no-op we'd rather
        // not throw on.
        const doc = yDoc;
        updateProjectSettings(projectId, patch)
          .then(() => {
            bumpProjectSettingsTick();
            try {
              bumpLiveSignal(doc, PROJECT_SETTINGS_SIGNAL);
            } catch {
              // The doc went with the project. Peers will re-read when
              // they next mount against the new one.
            }
          })
          .catch(() => {});
      }
    };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe as well as publish. The section that flushed a save on
  // its way out is gone, but this instance may have read the server
  // just before that PATCH landed — in which case it is showing a value
  // the author has already moved away from, with nothing else to
  // correct it. (It also makes a losing write visible: if a slow flush
  // lands after a newer save, the re-read shows what the server
  // actually holds rather than leaving the UI quietly disagreeing.)
  useEffect(() => {
    if (tick === handledTickRef.current) return;
    handledTickRef.current = tick;
    reload(true);
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  async function updateOne<K extends keyof ProjectSettings>(
    key: K,
    next: ProjectSettings[K],
  ): Promise<void> {
    setError(null);
    let originalValue: ProjectSettings[K] | undefined;
    let didCapture = false;
    setSettings((prev) => {
      const cur = prev ?? {};
      originalValue = cur[key];
      didCapture = true;
      return { ...cur, [key]: next };
    });
    try {
      const { settings: updated } = await updateProjectSettings(projectId, {
        [key]: next,
      });
      setSettings(updated);
      bumpLiveSignal(yDoc, PROJECT_SETTINGS_SIGNAL);
      // Our own save: the response above is already the newest truth,
      // so account for the tick rather than re-reading it.
      handledTickRef.current = bumpProjectSettingsTick();
    } catch (err) {
      setSettings((prev) => {
        if (!prev) return prev;
        // Only roll back if the user hasn't changed this key again
        // in the meantime. didCapture is paranoia for callers we
        // don't fully control.
        if (!didCapture || prev[key] !== next) return prev;
        return { ...prev, [key]: originalValue };
      });
      setError(err instanceof Error ? err.message : 'Failed to update setting');
    }
  }

  function updateDebounced<K extends keyof ProjectSettings>(
    key: K,
    next: ProjectSettings[K],
  ): void {
    setSettings((prev) => ({ ...(prev ?? {}), [key]: next }));
    const timers = debounceTimersRef.current;
    const pending = pendingSavesRef.current;
    const existing = timers.get(key as string);
    if (existing) clearTimeout(existing);
    pending.set(key as string, next);
    const t = setTimeout(async () => {
      // Cleared before the request, not after: an unmount mid-flight
      // must not send this key a second time.
      pending.delete(key as string);
      try {
        const { settings: updated } = await updateProjectSettings(projectId, {
          [key]: next,
        });
        setSettings(updated);
        bumpLiveSignal(yDoc, PROJECT_SETTINGS_SIGNAL);
        handledTickRef.current = bumpProjectSettingsTick();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save');
      } finally {
        timers.delete(key as string);
      }
    }, 250);
    timers.set(key as string, t);
  }

  return { settings, loading, error, setError, updateOne, updateDebounced, reload };
}
