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
   * independent, and for the same key only the newest one's result is
   * applied.
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
  // Per-key counter naming the newest save started for that key. Two
  // PATCHes for one key can be in flight at once — a slider's debounce
  // timer fires while the user keeps dragging — and nothing makes them
  // resolve in the order they were sent. Without this, the *earlier*
  // response could land last and snap the control back to a value the
  // user has already moved past, or report a failure the newer save has
  // since fixed. Only the newest save for a key writes its result.
  const saveGenerationRef = useRef<Map<string, number>>(new Map());

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
    // Read both refs here rather than in the cleanup: the Maps they hold
    // are created once and never replaced, so this is the same object
    // either way, and it keeps the cleanup off `.current`.
    const timers = debounceTimersRef.current;
    const generations = saveGenerationRef.current;
    return () => {
      // Cancel any pending debounced saves when the project switches...
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      // ...and retire every generation, so a save already in flight for
      // the old project can't write its response onto the new one's
      // freshly loaded settings.
      generations.clear();
    };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Claim the next generation for a key. The caller compares the number
   * it gets back against the current one before writing any result;
   * anything but a match means a newer save has taken over.
   */
  function nextGeneration(key: string): number {
    const generations = saveGenerationRef.current;
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    return generation;
  }

  function isCurrentGeneration(key: string, generation: number): boolean {
    return saveGenerationRef.current.get(key) === generation;
  }

  /**
   * Take just the patched key out of the server's response.
   *
   * The endpoint returns the whole merged settings object, but writing
   * all of it back would revert any *other* key the user changed while
   * this request was in flight: that key's new value isn't in this
   * response, because the server hadn't been told about it yet when it
   * built one. Reading only the key we patched is what makes the
   * "concurrent calls with different keys are independent" promise
   * above true. Use reload() when the whole object really should be
   * re-read.
   *
   * Reading it from the response rather than echoing `next` matters for
   * the keys the endpoint normalizes — a nested merge like
   * choiceIndicatorAudio comes back whole, and a guarded value like
   * choiceAudioDelayMs comes back clamped.
   */
  function applyServerValue<K extends keyof ProjectSettings>(key: K, updated: ProjectSettings) {
    setSettings((prev) => ({ ...(prev ?? {}), [key]: updated[key] }));
  }

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
    const generation = nextGeneration(key as string);
    try {
      const { settings: updated } = await updateProjectSettings(projectId, {
        [key]: next,
      });
      if (!isCurrentGeneration(key as string, generation)) return;
      applyServerValue(key, updated);
    } catch (err) {
      // A superseded save's failure is not the user's problem: the value
      // they're looking at came from a later request that is still in
      // flight or has already succeeded.
      if (!isCurrentGeneration(key as string, generation)) return;
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
    const name = key as string;
    // Claim the generation here rather than inside the timer. The value
    // on screen has already moved, so a response still in flight for an
    // older one is stale from this moment — waiting until the timer
    // fires would let it land first and bounce the control back to the
    // old value for the length of the debounce.
    const generation = nextGeneration(name);
    const timers = debounceTimersRef.current;
    const existing = timers.get(name);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      // This timer has fired, so it is no longer pending. Dropping it
      // here rather than once the round-trip finishes matters: clearing
      // the entry after the PATCH resolved would delete whatever timer a
      // later call had since stored under this key, so the next call
      // would find nothing to cancel and a second debounced PATCH would
      // run alongside the one still pending.
      if (timers.get(name) === t) timers.delete(name);
      void saveNow(key, next, generation);
    }, 250);
    timers.set(name, t);
  }

  /** The PATCH behind a debounced save, once its timer has fired. */
  async function saveNow<K extends keyof ProjectSettings>(
    key: K,
    next: ProjectSettings[K],
    generation: number,
  ): Promise<void> {
    const name = key as string;
    try {
      const { settings: updated } = await updateProjectSettings(projectId, {
        [key]: next,
      });
      if (!isCurrentGeneration(name, generation)) return;
      applyServerValue(key, updated);
    } catch (err) {
      if (!isCurrentGeneration(name, generation)) return;
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  return { settings, loading, error, setError, updateOne, updateDebounced, reload };
}
