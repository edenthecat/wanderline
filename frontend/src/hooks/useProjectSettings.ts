// Shared settings access for the per-section tools (Volumes, System
// sounds, Headphone controls, Player display, plus the trimmed-down
// Settings page for Password + Danger zone). Each section was its
// own block of state-and-PATCH code inside SettingsTab; pulling it
// here keeps the PATCH protocol consistent across the new tools
// (optimistic update, key-scoped rollback on failure).

import { useEffect, useRef, useState } from 'react';
import { fetchProjectSettings, updateProjectSettings, type ProjectSettings } from '../api/client';

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

export function useProjectSettings(projectId: string): UseProjectSettingsResult {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  async function reload() {
    setLoading(true);
    try {
      const { settings: data } = await fetchProjectSettings(projectId);
      setSettings(data);
      setError(null);
    } catch (err) {
      setSettings({});
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setError(null);
    setLoading(true);
    reload();
    // Cancel any pending debounced saves when the project switches.
    return () => {
      const timers = debounceTimersRef.current;
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const existing = timers.get(key as string);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      try {
        const { settings: updated } = await updateProjectSettings(projectId, {
          [key]: next,
        });
        setSettings(updated);
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
