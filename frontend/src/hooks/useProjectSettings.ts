// Shared settings access for the per-section tools (Volumes, System
// sounds, Headphone controls, Player display, plus the trimmed-down
// Settings page for Password + Danger zone). Each section was its
// own block of state-and-PATCH code inside SettingsTab; pulling it
// here keeps the PATCH protocol consistent across the new tools
// (optimistic update, key-scoped rollback on failure).

import { useEffect, useRef, useState } from 'react';
import { fetchProjectSettings, updateProjectSettings, type ProjectSettings } from '../api/client';

// How long a same-key save waits for the one ahead of it before giving up
// on the queue and sending anyway. Chaining same-key saves (see
// runSerialized) fixes them arriving out of order, but it also means a
// predecessor that never settles — a dropped connection, a stalled proxy
// — would otherwise wedge every later save of that key behind it forever,
// silently: nothing rejects, so no error surfaces and the control just
// stops saving. This bounds that wait; on a normal request it never
// matters, since requests settle in milliseconds.
//
// Giving up also aborts the predecessor's own request (see runSerialized),
// which is a full fix when it's genuinely dead — a dropped connection, a
// request that never reached the server at all. It is not a full fix when
// the predecessor is merely slow and the server is still working through
// it: mergeSettings serialises concurrent writes with `SELECT … FOR
// UPDATE`, so a request already queued for that lock keeps running
// server-side regardless of what the client does with its own connection,
// and could still commit after this save's does. Closing that residual
// window needs the server to reject a write that's older than one it has
// already applied (a revision/sequence check), which is a bigger change
// than this hook can make on its own.
const STUCK_SAVE_TIMEOUT_MS = 15000;

// Keys whose PATCH value is a fragment, not a complete replacement —
// mirrors NESTED_MERGE_KEYS in backend/src/routes/projects-settings.ts.
// Read by saveNow below, which skips sending a superseded save for any
// key *not* in this set: the newest call already carries the whole
// intended value, so an older, still-queued one is a pure duplicate.
//
// This is specifically about saveNow (updateDebounced's PATCH), not
// updateOne. A debounced save's actual request is delayed behind its
// own 250ms timer, so a generation claimed *earlier* can still reach
// runSerialized *later* than a generation claimed after it — a direct
// updateOne call for the same key isn't behind a timer, so it can win
// the race and reach the server first. Without this skip, the older,
// now-stale debounced save would go out anyway once its timer finally
// fired, landing after the value it was superseded by and silently
// overwriting it server-side — invisible in the editor, since only the
// response side is otherwise generation-gated. updateOne itself never
// needs this: it enters the same-key queue the moment it's called, so
// its queue position always matches its call order and it can't lose
// this kind of race — see its own comment below.
//
// A key in this set can't be skipped in saveNow either, for the same
// reason updateOne always sends: SystemSoundsTab patches one side of
// choiceIndicatorAudio at a time, so a superseded call isn't a stale
// duplicate, it's a *different* sub-field nothing else will ever send.
const PARTIAL_PATCH_KEYS = new Set([
  'bluetoothControls',
  'theme',
  'choiceIndicatorAudio',
  'appIcon',
]);

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface UseProjectSettingsResult {
  settings: ProjectSettings | null;
  loading: boolean;
  error: string | null;
  setError: (s: string | null) => void;
  /**
   * PATCH a single key. Updates local state optimistically; on
   * failure rolls back JUST that key if the user hasn't changed it
   * again in the meantime — except for a nested-merge key (see
   * PARTIAL_PATCH_KEYS), where `next` is only a fragment and there is
   * no complete value to roll back to; those surface the failure
   * instead. Concurrent calls with different keys are independent, and
   * for the same key only the newest one's result is applied.
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
  // Monotonic id for saves, never reset. Deriving the next id from the
  // per-key map below instead would re-issue numbers after the map is
  // cleared on a project switch, and a slow response from the old
  // project would then match the new project's first save and write its
  // value there.
  const nextSaveIdRef = useRef(0);
  // The newest save id claimed for each key. A slider's debounce timer
  // can fire while the user keeps dragging, so a key can have a save
  // already sent and another on the way; only the newest one writes its
  // result, or reports its failure. Without this the *earlier* response
  // could land last and snap the control back to a value the user has
  // already moved past.
  const saveGenerationRef = useRef<Map<string, number>>(new Map());
  // The save currently in flight for each key, so same-key PATCHes are
  // chained rather than raced. mergeSettings serialises concurrent
  // writes, but whichever request *arrives* last wins — two in flight
  // for one key could leave the database holding the older value while
  // the editor showed the newer one, a desync that would only surface
  // on the next reload. Each entry also carries the AbortController for
  // that save's own request, so a successor giving up on a stuck
  // predecessor (see runSerialized) can cancel it outright rather than
  // merely stop waiting for it.
  const inFlightRef = useRef<Map<string, { promise: Promise<void>; controller: AbortController }>>(
    new Map(),
  );
  // Aborts every request — the load and any in-flight save — that
  // belongs to the project this hook is currently pointed at. Recreated
  // per projectId (see the effect below) so leaving a project cancels
  // its own outstanding work rather than leaving it to land, unordered,
  // on top of whatever the next project loads or saves.
  const projectAbortRef = useRef(new AbortController());
  // The last value this hook itself asked the server to store for each
  // key — from a load, a confirmed response, or a call's own optimistic
  // write — kept outside React state specifically so it's readable
  // *synchronously*, the instant it's written, with no dependence on
  // when React gets around to actually applying a queued setState.
  //
  // updateOne's rollback-and-resend needs exactly that: "what did this
  // key hold right before my own write", correct even when two calls
  // for the same key land without a render in between (a bulk apply, or
  // two controls firing in the same tick). Reading that from `settings`
  // via closure isn't enough — it only reflects the last *committed*
  // render, not a write queued moments before by another call in the
  // same batch. And capturing it from inside setSettings's own updater
  // (the obvious alternative) isn't safe to read from code that runs
  // straight after — React doesn't invoke that updater synchronously,
  // so the value isn't there yet.
  const lastValueRef = useRef(new Map<string, unknown>());

  async function reload() {
    setLoading(true);
    const signal = projectAbortRef.current.signal;
    try {
      const { settings: data } = await fetchProjectSettings(projectId, signal);
      lastValueRef.current = new Map(Object.entries(data));
      setSettings(data);
      setError(null);
    } catch (err) {
      // An aborted load means the author already navigated away from
      // this project — nothing to show here belongs to the project
      // this hook now points at, so there's nothing to correct either.
      if (isAbortError(err)) return;
      setSettings({});
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    projectAbortRef.current = controller;
    setError(null);
    setLoading(true);
    reload();
    // Read the refs here rather than in the cleanup: the Maps they hold
    // are created once and never replaced, so these are the same objects
    // either way, and it keeps the cleanup off `.current`.
    const timers = debounceTimersRef.current;
    const generations = saveGenerationRef.current;
    const inFlight = inFlightRef.current;
    return () => {
      // Cancel the load and every in-flight save for the project we're
      // leaving. This is what actually stops one of them from landing —
      // successfully, from the server's point of view — after the next
      // project's own load or save has already completed; the map
      // clears below only stop a stale *response* from being displayed,
      // they can't reach back and undo a request already in flight.
      controller.abort();
      // Cancel any pending debounced saves when the project switches...
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      // ...retire every generation, so a save already in flight for the
      // old project can't write its response onto the new one's freshly
      // loaded settings (the ids are never re-issued, so retiring is
      // permanent)...
      generations.clear();
      // ...abort every in-flight save's own request too — clearing the
      // map on its own only stops the *next* project's saves queueing
      // behind these, it doesn't touch the requests already sent, which
      // would otherwise keep running and could still land after this
      // project has been left behind...
      inFlight.forEach((entry) => entry.controller.abort());
      // ...and now that they're cancelled, drop them, so the next
      // project's saves have nothing to queue behind.
      inFlight.clear();
      // Drop every recorded value too, so a call for the new project,
      // made before its own reload() has finished repopulating this,
      // can't capture a rollback target that belongs to the project just
      // left. lastValueRef.current itself is about to be replaced
      // wholesale by that reload() anyway (see there), but clearing here
      // closes the window between now and then.
      lastValueRef.current.clear();
    };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Claim the next generation for a key. The caller compares the number
   * it gets back against the current one before writing any result;
   * anything but a match means a newer save has taken over.
   */
  function nextGeneration(key: string): number {
    const generation = ++nextSaveIdRef.current;
    saveGenerationRef.current.set(key, generation);
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
  /**
   * Write `value` for `key` to both React state and lastValueRef
   * together, so the two — deliberately tracked separately, see
   * lastValueRef's own comment — can never drift apart by one call site
   * updating one and forgetting the other.
   */
  function setTracked<K extends keyof ProjectSettings>(
    key: K,
    value: ProjectSettings[K] | undefined,
  ) {
    lastValueRef.current.set(key as string, value);
    setSettings((prev) => ({ ...(prev ?? {}), [key]: value }));
  }

  function applyServerValue<K extends keyof ProjectSettings>(key: K, updated: ProjectSettings) {
    // Every call site already checked isCurrentGeneration before calling
    // this, so this is always the newest, winning response for the key —
    // exactly what lastValueRef should hold going forward. Matters for a
    // key the endpoint normalizes (choiceAudioDelayMs's own clamp, for
    // one): without this, a later rollback would target the raw value
    // this call sent, not what the server actually ended up storing.
    //
    // Narrow residual gap: a response that's *superseded* by the time it
    // arrives never reaches here at all (the generation check at each
    // call site returns first), so its normalized value never reaches
    // lastValueRef either. If updateOne(A) is still in flight when
    // updateOne(B) starts, and A's later, superseded response would have
    // normalized to some A', a subsequent failure of B rolls back to the
    // raw A rather than A'. Self-correcting once the resend that
    // rollback triggers gets its own response (which does reach here,
    // being the new current generation), so the wrong value is transient
    // rather than sticking — but the window exists.
    setTracked(key, updated[key]);
  }

  /**
   * Run a save for `key` only once the save already in flight for that
   * key has finished, so two PATCHes for one key can't arrive at the
   * endpoint in the opposite order to the one they were sent in —
   * unless the one ahead of it is stuck, past STUCK_SAVE_TIMEOUT_MS, in
   * which case this one stops waiting, cancels it, and goes anyway (see
   * STUCK_SAVE_TIMEOUT_MS for what that does and doesn't guarantee).
   *
   * `body` is expected to handle its own failures; a predecessor that
   * rejects anyway is swallowed here rather than poisoning the chain for
   * every save queued behind it. It receives this save's own
   * AbortSignal, tied to both the project switch above and the
   * stuck-predecessor timeout below, so it can pass it on to the actual
   * request.
   */
  async function runSerialized(
    key: string,
    body: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const inFlight = inFlightRef.current;
    const previous = inFlight.get(key);
    const controller = new AbortController();
    const run = (async () => {
      if (previous) {
        // Race rather than a bare await: a predecessor stuck past the
        // timeout is given up on, and this save proceeds without it
        // rather than waiting forever. See STUCK_SAVE_TIMEOUT_MS.
        await Promise.race([
          previous.promise.catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, STUCK_SAVE_TIMEOUT_MS)),
        ]);
        // Cancel the predecessor's own request outright rather than
        // just moving on without it. If it already settled, this is a
        // no-op; if it was genuinely stuck (a dropped connection, a
        // stalled proxy — never reached the server at all), this is
        // what stops it from ever arriving after ours does.
        previous.controller.abort();
      }
      await body(controller.signal);
    })();
    inFlight.set(key, { promise: run, controller });
    try {
      await run;
    } finally {
      if (inFlight.get(key)?.promise === run) inFlight.delete(key);
    }
  }

  /**
   * Send `value` for `key` once more, applying the normal
   * generation-gated response handling but without a rollback of its
   * own on failure. Used only by updateOne's catch block, to make sure
   * a value it rolls back to actually reaches the server rather than
   * relying on some earlier save (already skipped for being
   * "superseded" — see PARTIAL_PATCH_KEYS / saveNow) to have sent it.
   * Not rolling back on its own failure bounds this to a single retry
   * rather than bouncing the value back and forth against a
   * consistently failing network.
   */
  async function sendOnce<K extends keyof ProjectSettings>(
    key: K,
    value: ProjectSettings[K],
    generation: number,
  ): Promise<void> {
    const name = key as string;
    await runSerialized(name, async (signal) => {
      if (!isCurrentGeneration(name, generation)) return;
      try {
        const { settings: updated } = await updateProjectSettings(
          projectId,
          { [key]: value },
          signal,
        );
        if (!isCurrentGeneration(name, generation)) return;
        // This retry exists to recover from the failure that triggered
        // it — succeeding means that failure is resolved, so the error
        // it left up should clear rather than linger describing a
        // problem that's already fixed.
        setError(null);
        applyServerValue(key, updated);
      } catch (err) {
        if (isAbortError(err) || !isCurrentGeneration(name, generation)) return;
        setError(err instanceof Error ? err.message : 'Failed to update setting');
      }
    });
  }

  async function updateOne<K extends keyof ProjectSettings>(
    key: K,
    next: ProjectSettings[K],
  ): Promise<void> {
    setError(null);
    const name = key as string;
    // Read and immediately overwrite lastValueRef, synchronously — not
    // `settings` via closure, and not from inside the setSettings call
    // below. Two updateOne calls for the same key can happen without a
    // render in between (a bulk apply, two controls firing in the same
    // tick): reading `settings` would give BOTH calls the same stale
    // pre-either-of-them value, and if the first succeeds and the second
    // then fails, the second's rollback+resend would clobber the first
    // call's already-confirmed write back down to that stale value. An
    // earlier version of this fix did exactly that, caught by mutating
    // this exact scenario into a test rather than by inspection.
    // lastValueRef sidesteps it: it's a plain ref, not React state, so
    // each call's write to it is visible to the very next call
    // immediately, with no dependency on when — or in what order
    // relative to this code — React gets around to applying anything.
    const originalValue = lastValueRef.current.get(name) as ProjectSettings[K] | undefined;
    setTracked(key, next);
    const generation = nextGeneration(name);
    await runSerialized(name, async (signal) => {
      // Always send, even if queueing let a newer change to this key
      // take over first. Unlike updateDebounced (see PARTIAL_PATCH_KEYS
      // and saveNow below), updateOne enters the same-key queue the
      // moment it's called, with no timer in between — so its position
      // in that queue always matches the order it was actually called
      // in, and sending a superseded value here can at most be a
      // redundant round-trip, never one that lands out of order. For a
      // partial-patch key that redundancy is required anyway: `next` is
      // a fragment — one dropdown's worth — that the newer save knows
      // nothing about, so skipping it here would drop it for good.
      try {
        const { settings: updated } = await updateProjectSettings(
          projectId,
          { [key]: next },
          signal,
        );
        if (!isCurrentGeneration(name, generation)) return;
        applyServerValue(key, updated);
      } catch (err) {
        if (isAbortError(err)) return;
        if (PARTIAL_PATCH_KEYS.has(name)) {
          // Always surface the failure, regardless of generation: a
          // newer save for this key carries a *different* sub-field's
          // fragment, not a value that supersedes this one, so this
          // failure is the only record that `next`'s sub-field never
          // reached the server, and nothing else is going to resend it.
          setError(err instanceof Error ? err.message : 'Failed to update setting');
          // No rollback, deliberately: for a partial-patch key,
          // originalValue and `next` are both fragments — one
          // sub-field's worth — never this key's complete value (that
          // only exists merged, server-side). Writing a fragment into
          // `settings[key]` as if it were the whole thing would wipe
          // out whatever sub-field this specific call didn't touch,
          // corrupting the *other* side's displayed value along with
          // this one. The edit is lost either way; surfacing the error
          // above is the most this function can safely do on its own.
          return;
        }
        if (!isCurrentGeneration(name, generation)) return;
        setError(err instanceof Error ? err.message : 'Failed to update setting');
        // Only roll back (and resend) if nothing has claimed this key
        // as its own intended value since this call's own write.
        // lastValueRef, not React state: it's the one check in this
        // function that has to be correct the instant it's read, for
        // the same reason capturing originalValue above did.
        if (lastValueRef.current.get(name) !== next) return;
        setTracked(key, originalValue);
        // The rollback above can restore a value that was never actually
        // sent: a debounced predecessor for this same key may have had
        // its own send skipped in saveNow for being "superseded" by
        // this call, on the assumption that this call's value — not the
        // debounced one — would become the one the server ends up with.
        // Since this call just failed, that assumption didn't hold, so
        // resend the value we're rolling back to ourselves.
        if (originalValue !== undefined) {
          void sendOnce(key, originalValue, generation);
        }
      }
    });
  }

  function updateDebounced<K extends keyof ProjectSettings>(
    key: K,
    next: ProjectSettings[K],
  ): void {
    const name = key as string;
    // setTracked (not a bare setSettings) so a *later* updateOne call
    // for this same key — e.g. a direct control changed while this
    // debounced one is still pending — reads this value as its own
    // rollback target, rather than whatever was there before this call.
    // See updateOne's own comment on lastValueRef.
    setTracked(key, next);
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
    await runSerialized(name, async (signal) => {
      // Same reasoning as updateOne. This is the case PARTIAL_PATCH_KEYS'
      // own comment describes: this save's actual request was delayed
      // behind its 250ms debounce timer, so by the time it gets here a
      // direct, un-debounced call for the same key can already have
      // reached the server and won — sending this stale value now would
      // silently overwrite it.
      if (!PARTIAL_PATCH_KEYS.has(name) && !isCurrentGeneration(name, generation)) return;
      try {
        const { settings: updated } = await updateProjectSettings(
          projectId,
          { [key]: next },
          signal,
        );
        if (!isCurrentGeneration(name, generation)) return;
        setError(null);
        applyServerValue(key, updated);
      } catch (err) {
        if (isAbortError(err)) return;
        if (!PARTIAL_PATCH_KEYS.has(name) && !isCurrentGeneration(name, generation)) return;
        setError(err instanceof Error ? err.message : 'Failed to save');
      }
    });
  }

  return { settings, loading, error, setError, updateOne, updateDebounced, reload };
}
