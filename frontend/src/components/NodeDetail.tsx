// The shared node-editor panel. Renders content + tags, the
// voiceover-script override editor, timing/auto-advance settings,
// editable choice rows with collaborative inputs, and an editable
// divert dropdown.
//
// Lives outside StoryTab so both the list view and the graph view's
// detail rail render the same component (so authors get the same
// editing affordances regardless of where they jumped in from).

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import * as Y from 'yjs';
import type { NodeMetadata } from '../api/client';
import CollabChoiceTextInput from './CollabChoiceTextInput';
import CollabContentTextarea from './CollabContentTextarea';
import { getChoiceText, getContentText } from '../hooks/useStoryYDoc';

// Runtime defaults for per-node timing — duplicated in
// player-app/src/App.tsx (look for `?? 0` / `?? 2000` near the
// auto-advance path) and in backend/src/routes/metadata.ts (the
// INSERT COALESCE values). If any of these change, update all three
// sites in lockstep.
export const TIMING_DEFAULTS = {
  delayBeforeMs: 0,
  delayAfterMs: 0,
  autoAdvance: true,
  autoAdvanceDelayMs: 2000,
} as const;

// 60s — UI cap; values larger than this are almost certainly typos.
// Also keeps us well under Postgres INTEGER max.
export const MAX_TIMING_MS = 60_000;

/** Coerce a number-input string into a clean non-negative integer in
 * milliseconds. Accepts fractions and scientific notation (the user
 * can type / paste anything), but ROUNDS to the nearest integer so
 * the result matches what the DB column accepts, and clamps to
 * MAX_TIMING_MS so a runaway paste like "1e10" doesn't reach the API.
 * NaN / negative values fall to 0; positive Infinity (e.g. "1e999")
 * clamps to MAX_TIMING_MS for consistency with very-large finite inputs. */
export function parseMs(raw: string): number {
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n < 0) return 0;
  if (!Number.isFinite(n)) return MAX_TIMING_MS;
  return Math.min(MAX_TIMING_MS, Math.round(n));
}

/** True when any of the per-node timing fields diverge from the
 * player's runtime defaults. Used to render a badge in the node
 * header so authors can see at a glance which nodes have custom pacing. */
export function hasCustomTiming(meta?: NodeMetadata): boolean {
  if (!meta) return false;
  return (
    (meta.delayBeforeMs ?? TIMING_DEFAULTS.delayBeforeMs) !== TIMING_DEFAULTS.delayBeforeMs ||
    (meta.delayAfterMs ?? TIMING_DEFAULTS.delayAfterMs) !== TIMING_DEFAULTS.delayAfterMs ||
    (meta.autoAdvance ?? TIMING_DEFAULTS.autoAdvance) !== TIMING_DEFAULTS.autoAdvance ||
    (meta.autoAdvanceDelayMs ?? TIMING_DEFAULTS.autoAdvanceDelayMs) !==
      TIMING_DEFAULTS.autoAdvanceDelayMs
  );
}

export interface NodeDetailProps {
  nodeId: string;
  node: {
    content: { text: string; tags: string[] }[];
    choices: { text: string; target: string }[];
    divert: string | null;
    tags: string[];
    audio?: Record<string, unknown>;
  };
  metadata?: NodeMetadata;
  /** True once the bulk /metadata fetch for this project has resolved.
   * While false, the override editor is locked so a user can't unwittingly
   * overwrite an existing server-side override with empty text. */
  metadataLoaded: boolean;
  nodeIdSet: Set<string>;
  nodeIdOptions: ReactNode;
  onChoiceTextEdit: (choiceIndex: number, newText: string) => void;
  /** Edit one content paragraph's body text. Hooked through the same
   * debounced REST + Y.Doc collab pipeline as choice text. */
  onContentEdit: (contentIndex: number, newText: string) => void;
  onChoiceTargetEdit: (choiceIndex: number, newTarget: string) => void;
  onDivertEdit: (newTarget: string) => void;
  /** Append a fresh choice. Optional — when omitted, the "+ Add choice"
   * button is hidden (e.g. for read-only contexts). */
  onAddChoice?: (choice: { text: string; target: string }) => Promise<void>;
  /** Remove a choice by index. Optional — hides the per-row delete button when omitted. */
  onDeleteChoice?: (choiceIndex: number) => Promise<void>;
  /** Move a choice up/down via index swap. Optional — hides the reorder buttons when omitted. */
  onSwapChoices?: (fromIndex: number, toIndex: number) => Promise<void>;
  onMetadataSave: (patch: Partial<NodeMetadata>) => Promise<void>;
  /** Optional list of node ids that choose-into or divert-into this node.
   * Rendered as a small "Reachable from" panel so authors can see context
   * before editing. Caller computes this from the storyGraph. */
  reachableFrom?: string[];
  /** Click a "Reachable from" entry to jump the canvas / list to it. */
  onJumpToNode?: (nodeId: string) => void;
  /**: shared Y.Doc for this project (null until connected).
   * When present, CollabChoiceTextInput resolves the choice's Y.Text
   * through it and binds collaboratively; otherwise it falls back to
   * the uncontrolled + REST PATCH path. */
  yDoc: Y.Doc | null;
  /** Becomes true once the Y.Doc's nodes map has been seeded by the
   * server. Y.Doc updates don't re-render React on their own, so
   * NodeDetail gates the collab-input path on this; otherwise a
   * first render that arrives before the WS sync would lock the
   * legacy path in even after the seed lands. */
  yDocReady: boolean;
}

export default function NodeDetail({
  nodeId,
  node,
  metadata,
  metadataLoaded,
  nodeIdSet,
  nodeIdOptions,
  onChoiceTextEdit,
  onContentEdit,
  onChoiceTargetEdit,
  onDivertEdit,
  onAddChoice,
  onDeleteChoice,
  onSwapChoices,
  onMetadataSave,
  reachableFrom,
  onJumpToNode,
  yDoc,
  yDocReady,
}: NodeDetailProps) {
  // Postgres column is nullable, so coerce null → '' for the editor.
  const savedTranscript = metadata?.transcript ?? '';
  const [transcript, setTranscript] = useState(savedTranscript);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Track the saved value we last propagated into the textarea, so the
  // re-sync effect can tell the difference between "props caught up
  // with what we already had" and "user typed something we shouldn't
  // overwrite".
  const lastSyncedSavedRef = useRef(savedTranscript);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  // Re-sync the editor when the parent's metadata snapshot changes —
  // BUT only when the user hasn't typed anything since the last sync.
  // Without this guard, a late-arriving bulk metadata fetch (or a
  // backend normalization on save) would silently wipe in-progress
  // edits.
  useEffect(() => {
    if (transcriptRef.current === lastSyncedSavedRef.current) {
      setTranscript(savedTranscript);
    }
    lastSyncedSavedRef.current = savedTranscript;
    setSaveError(null);
  }, [savedTranscript]);

  // Guard against setState-after-unmount. Save/Clear await network
  // round-trips; if the user collapses this node, switches tabs, or
  // filters this node out before the response lands, we drop the
  // final state writes instead of warning in the console.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isDirty = transcript !== savedTranscript;
  // Whitespace-only saves are treated as no-override so the player
  // doesn't read aloud ' ' / '\n'. hasOverride reflects what the
  // *player* will see, not what the database stores literally.
  const hasOverride = savedTranscript.trim().length > 0;
  const originalText = node.content
    .map((c) => c.text)
    .filter((s) => s.trim().length > 0)
    .join('\n\n');
  // Render the override block when the node has visible content OR
  // when an override is already saved. Without the second clause, a
  // routing knot whose Ink content is empty would silently retain its
  // pre-existing override with no UI to clear it.
  const showOverrideEditor = originalText.length > 0 || hasOverride;
  // While the bulk fetch hasn't resolved, lock the editor so the user
  // can't type-and-Save over an existing server override they can't
  // yet see.
  const editorLocked = !metadataLoaded || saving;

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const next = transcript.trim().length === 0 ? '' : transcript;
      await onMetadataSave({ transcript: next });
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save');
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    setSaveError(null);
    try {
      await onMetadataSave({ transcript: '' });
    } catch (err) {
      if (mountedRef.current) {
        setSaveError(err instanceof Error ? err.message : 'Failed to clear');
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  function handleRevert() {
    setTranscript(savedTranscript);
    setSaveError(null);
  }

  // ── Timing & auto-advance ─────────────────────────────────────────
  const savedDelayBeforeMs = metadata?.delayBeforeMs ?? TIMING_DEFAULTS.delayBeforeMs;
  const savedDelayAfterMs = metadata?.delayAfterMs ?? TIMING_DEFAULTS.delayAfterMs;
  const savedAutoAdvance = metadata?.autoAdvance ?? TIMING_DEFAULTS.autoAdvance;
  const savedAutoAdvanceDelayMs =
    metadata?.autoAdvanceDelayMs ?? TIMING_DEFAULTS.autoAdvanceDelayMs;

  const [delayBeforeMs, setDelayBeforeMs] = useState(savedDelayBeforeMs);
  const [delayAfterMs, setDelayAfterMs] = useState(savedDelayAfterMs);
  const [autoAdvance, setAutoAdvance] = useState(savedAutoAdvance);
  const [autoAdvanceDelayMs, setAutoAdvanceDelayMs] = useState(savedAutoAdvanceDelayMs);
  const [timingSaving, setTimingSaving] = useState(false);
  const [timingError, setTimingError] = useState<string | null>(null);

  const lastDelayBeforeRef = useRef(savedDelayBeforeMs);
  const lastDelayAfterRef = useRef(savedDelayAfterMs);
  const lastAutoAdvanceRef = useRef(savedAutoAdvance);
  const lastAutoAdvanceDelayRef = useRef(savedAutoAdvanceDelayMs);
  const delayBeforeMsRef = useRef(delayBeforeMs);
  const delayAfterMsRef = useRef(delayAfterMs);
  const autoAdvanceRef = useRef(autoAdvance);
  const autoAdvanceDelayMsRef = useRef(autoAdvanceDelayMs);
  delayBeforeMsRef.current = delayBeforeMs;
  delayAfterMsRef.current = delayAfterMs;
  autoAdvanceRef.current = autoAdvance;
  autoAdvanceDelayMsRef.current = autoAdvanceDelayMs;

  useEffect(() => {
    if (delayBeforeMsRef.current === lastDelayBeforeRef.current) {
      setDelayBeforeMs(savedDelayBeforeMs);
      lastDelayBeforeRef.current = savedDelayBeforeMs;
    }
    if (delayAfterMsRef.current === lastDelayAfterRef.current) {
      setDelayAfterMs(savedDelayAfterMs);
      lastDelayAfterRef.current = savedDelayAfterMs;
    }
    if (autoAdvanceRef.current === lastAutoAdvanceRef.current) {
      setAutoAdvance(savedAutoAdvance);
      lastAutoAdvanceRef.current = savedAutoAdvance;
    }
    if (autoAdvanceDelayMsRef.current === lastAutoAdvanceDelayRef.current) {
      setAutoAdvanceDelayMs(savedAutoAdvanceDelayMs);
      lastAutoAdvanceDelayRef.current = savedAutoAdvanceDelayMs;
    }
    setTimingError(null);
  }, [savedDelayBeforeMs, savedDelayAfterMs, savedAutoAdvance, savedAutoAdvanceDelayMs]);

  const timingDirty =
    delayBeforeMs !== savedDelayBeforeMs ||
    delayAfterMs !== savedDelayAfterMs ||
    autoAdvance !== savedAutoAdvance ||
    (autoAdvance && autoAdvanceDelayMs !== savedAutoAdvanceDelayMs);
  const timingLocked = !metadataLoaded || timingSaving;

  async function handleTimingSave() {
    setTimingSaving(true);
    setTimingError(null);
    try {
      const patch: Partial<NodeMetadata> = {
        delayBeforeMs,
        delayAfterMs,
        autoAdvance,
      };
      if (autoAdvance) patch.autoAdvanceDelayMs = autoAdvanceDelayMs;
      await onMetadataSave(patch);
    } catch (err) {
      if (mountedRef.current) {
        setTimingError(err instanceof Error ? err.message : 'Failed to save');
      }
    } finally {
      if (mountedRef.current) setTimingSaving(false);
    }
  }

  function handleTimingRevert() {
    setDelayBeforeMs(savedDelayBeforeMs);
    setDelayAfterMs(savedDelayAfterMs);
    setAutoAdvance(savedAutoAdvance);
    setAutoAdvanceDelayMs(savedAutoAdvanceDelayMs);
    setTimingError(null);
  }

  // While any swap/delete is in flight, lock the per-row ↑/↓/✕
  // buttons. The choice indices the user clicked are about to be
  // invalidated by the refetch; a second click on stale indices
  // would operate on a different choice than the user expects (or
  // delete the wrong one).
  const [pendingChoiceOp, setPendingChoiceOp] = useState(false);
  const runChoiceOp = useCallback(async (op: () => Promise<unknown>) => {
    setPendingChoiceOp(true);
    try {
      await op();
    } catch {
      // Errors are surfaced by the parent's editorError banner.
    } finally {
      setPendingChoiceOp(false);
    }
  }, []);

  return (
    <div className="node-detail">
      {node.content.length > 0 && (
        <div className="node-content">
          {node.content.map((c, i) => (
            <div key={i} className="node-content-row">
              <CollabContentTextarea
                yText={yDocReady ? getContentText(yDoc, nodeId, i) : null}
                initialText={c.text}
                onLocalEdit={(text) => onContentEdit(i, text)}
                ariaLabel={`Content line ${i + 1} on ${nodeId}`}
                className="node-content-input"
              />
              {c.tags.length > 0 && (
                <span className="node-tags">
                  {c.tags.map((t, j) => (
                    <span key={j} className="tag">
                      #{t}
                    </span>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {showOverrideEditor && (
        <div className="transcript-override">
          <label className="transcript-override-label" htmlFor={`transcript-${nodeId}`}>
            Voiceover script override
            {hasOverride && <span className="badge badge-blue">active</span>}
          </label>
          <p className="text-sm text-muted transcript-override-hint">
            Customize what gets read aloud / shown as the transcript without changing the original
            Ink text. Leave empty to use the Ink content.
          </p>
          <textarea
            id={`transcript-${nodeId}`}
            className="transcript-override-input"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder={
              metadataLoaded
                ? originalText || 'No Ink content for this node — write the spoken text here.'
                : 'Loading existing override…'
            }
            rows={Math.min(20, Math.max(2, transcript.split('\n').length))}
            disabled={editorLocked}
            aria-busy={!metadataLoaded}
          />
          <div className="transcript-override-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={editorLocked || !isDirty}
            >
              {saving ? 'Saving…' : 'Save override'}
            </button>
            {isDirty && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleRevert}
                disabled={saving}
              >
                Discard changes
              </button>
            )}
            {hasOverride && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleClear}
                disabled={editorLocked}
              >
                Clear override
              </button>
            )}
            {saveError && <span className="text-sm text-danger">{saveError}</span>}
          </div>
        </div>
      )}

      <div className="transcript-override timing-controls">
        <label className="transcript-override-label">Timing & auto-advance</label>
        <p className="text-sm text-muted transcript-override-hint">
          Control how the player paces this node. Auto-advance moves to the next node once the
          voiceover ends; toggle off for nodes the listener should stay on (e.g. branch decisions).
        </p>
        <div className="timing-grid">
          <label className="timing-field">
            <span>Pre-roll delay before voiceover (ms)</span>
            <input
              type="number"
              min={0}
              max={MAX_TIMING_MS}
              step={100}
              value={delayBeforeMs}
              onChange={(e) => setDelayBeforeMs(parseMs(e.target.value))}
              disabled={timingLocked}
            />
          </label>
          <label className="timing-field">
            <span>Extra pause before auto-advance (ms)</span>
            <input
              type="number"
              min={0}
              max={MAX_TIMING_MS}
              step={100}
              value={delayAfterMs}
              onChange={(e) => setDelayAfterMs(parseMs(e.target.value))}
              disabled={timingLocked || !autoAdvance}
              title="Only used when auto-advance is on. Stacks on top of the auto-advance delay below."
            />
          </label>
          <label className="timing-field timing-field-checkbox">
            <input
              type="checkbox"
              checked={autoAdvance}
              onChange={(e) => setAutoAdvance(e.target.checked)}
              disabled={timingLocked}
            />
            <span>Auto-advance after audio ends</span>
          </label>
          <label className="timing-field">
            <span>Auto-advance delay (ms)</span>
            <input
              type="number"
              min={0}
              max={MAX_TIMING_MS}
              step={100}
              value={autoAdvanceDelayMs}
              onChange={(e) => setAutoAdvanceDelayMs(parseMs(e.target.value))}
              disabled={timingLocked || !autoAdvance}
            />
          </label>
        </div>
        <div className="transcript-override-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleTimingSave}
            disabled={timingLocked || !timingDirty}
          >
            {timingSaving ? 'Saving…' : 'Save timing'}
          </button>
          {timingDirty && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleTimingRevert}
              disabled={timingSaving}
            >
              Discard changes
            </button>
          )}
          {timingError && <span className="text-sm text-danger">{timingError}</span>}
        </div>
      </div>

      {(node.choices.length > 0 || onAddChoice) && (
        <div className="node-choices">
          {node.choices.map((ch, i) => (
            <div key={i} className="node-choice">
              <span className="choice-arrow">&rarr;</span>
              <CollabChoiceTextInput
                yText={yDocReady ? getChoiceText(yDoc, nodeId, i) : null}
                initialText={ch.text}
                onLocalEdit={(text) => onChoiceTextEdit(i, text)}
                ariaLabel={`Choice ${i + 1} text`}
                className="input input-inline"
              />
              <span className="choice-arrow">&rarr;</span>
              <select
                className="select select-inline"
                key={ch.target}
                defaultValue={ch.target}
                onChange={(e) => onChoiceTargetEdit(i, e.target.value)}
                aria-label={`Choice ${i + 1} target`}
              >
                {!nodeIdSet.has(ch.target) && ch.target !== 'END' && ch.target !== 'DONE' && (
                  <option value={ch.target}>{ch.target} (missing)</option>
                )}
                {nodeIdOptions}
              </select>
              {(onSwapChoices || onDeleteChoice) && (
                <span className="node-choice-actions">
                  {onSwapChoices && (
                    <>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => runChoiceOp(() => onSwapChoices(i, i - 1))}
                        disabled={i === 0 || pendingChoiceOp}
                        aria-label={`Move choice ${i + 1} up`}
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => runChoiceOp(() => onSwapChoices(i, i + 1))}
                        disabled={i === node.choices.length - 1 || pendingChoiceOp}
                        aria-label={`Move choice ${i + 1} down`}
                        title="Move down"
                      >
                        ↓
                      </button>
                    </>
                  )}
                  {onDeleteChoice && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs node-choice-delete"
                      onClick={() => runChoiceOp(() => onDeleteChoice(i))}
                      disabled={pendingChoiceOp}
                      aria-label={`Delete choice ${i + 1}`}
                      title="Delete choice"
                    >
                      ✕
                    </button>
                  )}
                </span>
              )}
            </div>
          ))}
          {onAddChoice && (
            <AddChoiceRow
              defaultTarget={defaultNewChoiceTarget(node.choices, nodeIdSet)}
              nodeIdOptions={nodeIdOptions}
              onSubmit={(c) => onAddChoice(c)}
            />
          )}
        </div>
      )}
      {node.divert && (
        <div className="node-divert">
          <span className="text-muted">Diverts to: </span>
          <select
            className="select select-inline"
            key={node.divert}
            defaultValue={node.divert}
            onChange={(e) => onDivertEdit(e.target.value)}
            aria-label="Divert target"
          >
            {!nodeIdSet.has(node.divert) && node.divert !== 'END' && node.divert !== 'DONE' && (
              <option value={node.divert}>{node.divert} (missing)</option>
            )}
            {nodeIdOptions}
          </select>
        </div>
      )}
      {reachableFrom && reachableFrom.length > 0 && (
        <div className="node-reachable-from">
          <h4 className="node-reachable-from-title">Reachable from</h4>
          <ul className="node-reachable-from-list">
            {reachableFrom.map((id) => (
              <li key={id}>
                {onJumpToNode ? (
                  <button
                    type="button"
                    className="node-reachable-from-link"
                    onClick={() => onJumpToNode(id)}
                  >
                    {id}
                  </button>
                ) : (
                  <span className="node-reachable-from-link">{id}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Inline "+ Add choice" row. Manages its own input state so the
// parent doesn't have to. Submits to onSubmit, which is expected to
// call the API and trigger a refetch; on success the input clears.
function defaultNewChoiceTarget(_existing: { target: string }[], _nodeIdSet: Set<string>): string {
  // Always default a new choice's target to END. The user has to
  // pick a real destination consciously — silently defaulting to
  // the first node in Object.keys order made it easy to publish
  // broken stories by hitting "Add" too fast, and defaulting to an
  // existing choice's target silently funnels the new choice to the
  // same place. END is always synthetic, always valid, and forces
  // an explicit choice for any non-terminal branch.
  return 'END';
}

interface AddChoiceRowProps {
  defaultTarget: string;
  nodeIdOptions: ReactNode;
  onSubmit: (choice: { text: string; target: string }) => Promise<void>;
}
function AddChoiceRow({ defaultTarget, nodeIdOptions, onSubmit }: AddChoiceRowProps) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState(defaultTarget);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-sync target when the upstream default changes (e.g. the
  // previously-defaulted-to target was just deleted). Without this,
  // a stale id would silently get POSTed. We only sync when the user
  // hasn't actively picked a different target — detected by comparing
  // local state to the previous default we saw.
  const lastDefaultRef = useRef(defaultTarget);
  useEffect(() => {
    if (target === lastDefaultRef.current) {
      setTarget(defaultTarget);
    }
    lastDefaultRef.current = defaultTarget;
  }, [defaultTarget, target]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      await onSubmit({ text: text.trim(), target });
      setText('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="node-choice node-choice-add" onSubmit={handleSubmit}>
      <span className="choice-arrow">+</span>
      <input
        type="text"
        className="input input-inline"
        placeholder="New choice text…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="New choice text"
        disabled={saving}
      />
      <span className="choice-arrow">&rarr;</span>
      <select
        className="select select-inline"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        aria-label="New choice target"
        disabled={saving}
      >
        {nodeIdOptions}
      </select>
      <button type="submit" className="btn btn-primary btn-xs" disabled={saving || !text.trim()}>
        {saving ? 'Adding…' : 'Add'}
      </button>
      {err && <span className="text-sm text-danger">{err}</span>}
    </form>
  );
}
