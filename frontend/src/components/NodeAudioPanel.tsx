// A passage's audio, editable where the passage is edited.
//
// Attaching, swapping or clearing a clip used to mean leaving the node for
// the Audio tab, finding the node again in its assignment form, and coming
// back to check. An audio designer working through takes would do that
// once per clip. Here every slot can be auditioned, swapped for another
// file from the library, or cleared in place, sound effects can be timed
// against the narration, and the whole passage can be heard as a mix.
//
// Pickers only open on request: search results render one panel per
// match, and a picker per slot per result would build the whole library
// as <option>s hundreds of times over. Choosing is pick-then-confirm, so
// arrowing through a closed <select> (which changes its value on
// Windows/Linux) can't swap a take by accident.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  audioFileUrl,
  type AudioAssignments,
  type AudioAssignmentVariant,
  type AudioFile,
  type ComparisonOperator,
  type SimpleCondition,
  type VariableDeclaration,
  type VariableValue,
} from '../api/client';
import { useAudition } from '../hooks/useAudition';
import { useMixAudition } from '../hooks/useMixAudition';
import type { NodeAudioActions, NodeAudioSlot } from '../hooks/useNodeEditor';
import AuditionButton from './AuditionButton';

type SingleSlot = Exclude<NodeAudioSlot, 'sfx'>;

/** A short, human-readable summary of a condition, for labelling a
 * conditioned variant's row — e.g. "mood == angry". */
function describeCondition(condition: SimpleCondition): string {
  const value =
    typeof condition.value === 'string' ? `"${condition.value}"` : String(condition.value);
  return `${condition.variable} ${condition.operator} ${value}`;
}

const COMPARISON_OPERATORS: { value: ComparisonOperator; label: string }[] = [
  { value: '==', label: '=' },
  { value: '!=', label: '≠' },
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: '>', label: '>' },
  { value: '>=', label: '≥' },
];

/** Operators that make sense for a variable's declared type — a
 * string/bool only ever supports equality; ordering operators on a
 * string would be legal (lexicographic) but confusing to offer here. */
function operatorsFor(type: VariableDeclaration['type']): ComparisonOperator[] {
  return type === 'number' ? ['==', '!=', '<', '<=', '>', '>='] : ['==', '!='];
}

/** How long a replace or remove waits for that effect's timing to save. */
const SAVE_WAIT_CAP_MS = 10_000;

/** What the server takes for a new take; `audio/*` would offer .m4a,
 * .flac and friends only for them to be refused. */
export const TAKE_FORMATS = '.mp3,.wav,.ogg,.webm,audio/mpeg,audio/wav,audio/ogg,audio/webm';

type SlotDescriptor = { key: SingleSlot; label: string; category: string };

const FIXED_SLOTS: SlotDescriptor[] = [
  { key: 'voiceover', label: 'Voiceover', category: 'voiceover' },
  { key: 'ambience', label: 'Ambience', category: 'ambience' },
];

/**
 * The two choice-cue slots — same positions (first/second) the
 * player's read-aloud sequence always had, but addressed by that
 * choice's own stable id when it has one (DEV-199 stable-id
 * rollout) rather than the fragile 'choice1'/'choice2' ordinal keys,
 * which silently misattribute if choices are ever reordered. A
 * choice with no id (data from before the rollout) still only has
 * those ordinal keys to use.
 */
function choiceCueSlots(choices: { id?: string; text: string }[]): SlotDescriptor[] {
  return choices.slice(0, 2).map((choice, i) => ({
    key: choice.id ? (`choice:${choice.id}` as const) : i === 0 ? 'choice1' : 'choice2',
    label: `Choice ${i + 1} cue`,
    category: 'choice',
  }));
}

/** Resolves a slot descriptor's variants, whether it's a fixed
 * property on AudioAssignments[nodeId] or a choice addressed by id
 * (looked up in the `choices` map instead). */
function variantsForSlot(
  nodeAudio: AudioAssignments[string] | undefined,
  key: SingleSlot,
): AudioAssignmentVariant[] | undefined {
  if (key.startsWith('choice:')) {
    return nodeAudio?.choices?.[key.slice('choice:'.length)];
  }
  return nodeAudio?.[key as 'voiceover' | 'ambience' | 'choice1' | 'choice2'];
}

interface Props {
  projectId: string;
  nodeId: string;
  nodeAudio?: AudioAssignments[string];
  audioNames?: Record<string, string>;
  audioFiles?: AudioFile[];
  /** Absent: the panel is read-only (audition only). */
  actions?: NodeAudioActions;
  /** Default levels (0-100) for the mix audition. */
  levels?: { voiceover: number; ambience: number };
  /** The project's declared story variables, for building a
   * variable-conditioned audio variant. Absent or empty: the "add a
   * conditional variant" affordance doesn't render — there's nothing
   * to condition on yet. */
  declaredVariables?: VariableDeclaration[];
  /** This node's own choices, for addressing the first/second
   * choice-cue slot by that choice's stable id rather than its
   * ordinal position. Absent or empty: both cue slots fall back to
   * the legacy 'choice1'/'choice2' keys, same as before this field
   * existed. */
  choices?: { id?: string; text: string }[];
}

/** Seconds as the author types them; '' means "as the passage starts". */
export function parseOffsetSeconds(text: string): number | null | 'invalid' {
  const t = text.trim();
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return 'invalid';
  const ms = Math.round(Number(t) * 1000);
  return ms <= 3_600_000 ? ms : 'invalid';
}

export function formatOffsetSeconds(ms: number | undefined): string {
  if (ms === undefined) return '';
  return String(Number((ms / 1000).toFixed(3)));
}

/** The slot's unconditioned/fallback variant, if any — what plays
 * when no conditioned variant's condition currently matches. Used
 * for the mix-audition preview, which previews a static mix rather
 * than simulating live variable state. */
function defaultVariant(variants?: AudioAssignmentVariant[]): AudioAssignmentVariant | undefined {
  return variants?.find((v) => !v.condition);
}

export default function NodeAudioPanel({
  projectId,
  nodeId,
  nodeAudio,
  audioNames,
  audioFiles = [],
  actions,
  levels = { voiceover: 100, ambience: 50 },
  declaredVariables = [],
  choices = [],
}: Props) {
  const clip = useAudition();
  const mix = useMixAudition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which row's picker is open: a slot key, `${slotKey}:cond` (the new-
  // conditional-variant picker), 'sfx:<fileId>' or 'add-sfx'.
  const [picking, setPicking] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  // Which slot's "add a conditional variant" builder is open.
  const [addingConditionFor, setAddingConditionFor] = useState<NodeAudioSlot | null>(null);

  // Cheap to recompute every render (at most 2 entries) — not worth
  // a useMemo dependency on an array prop the parent likely passes a
  // fresh reference for anyway.
  const SLOTS = [...FIXED_SLOTS, ...choiceCueSlots(choices)];

  const sfx = nodeAudio?.sfx ?? [];
  const offsets = nodeAudio?.sfxOffsets ?? {};
  const attachedSlots = SLOTS.filter((s) => (variantsForSlot(nodeAudio, s.key)?.length ?? 0) > 0);
  // Not the complement of attachedSlots any more: a slot can have
  // conditioned-only variants (no default yet) and still need the
  // simple "Attach audio…" flow to add the default/fallback — that's
  // the ONLY in-panel way to add one, since the conditional-variant
  // builder always requires a condition.
  const slotsWithoutDefault = SLOTS.filter(
    (s) => !defaultVariant(variantsForSlot(nodeAudio, s.key)),
  );
  const hasAnything = attachedSlots.length > 0 || sfx.length > 0;
  const canEdit = !!actions && audioFiles.length > 0;
  const canAddCondition = canEdit && declaredVariables.length > 0;
  const ambienceDefault = defaultVariant(nodeAudio?.ambience);
  const canMix = !!ambienceDefault || sfx.length > 0;

  // A peer's change can take away what the mix was playing, and with it
  // the Stop button; don't leave a bed looping with no way to stop it.
  const { stop: stopMix } = mix;
  useEffect(() => {
    if (!canMix) stopMix();
  }, [canMix, stopMix]);

  // Nothing attached and nothing to attach from: stay out of the way, as
  // the read-only preview always did.
  const takeInputRef = useRef<HTMLInputElement>(null);
  const pendingSavesRef = useRef(new Map<string, Promise<boolean>>());
  const takeForRef = useRef<string | null>(null);

  if (!hasAnything && !canEdit) return null;

  const name = (fileId: string) =>
    audioNames?.[fileId] ?? audioFiles.find((f) => f.id === fileId)?.original_name ?? fileId;
  // Versioned by the stored filename, which changes with each new take.
  const src = (fileId: string) =>
    audioFileUrl(projectId, fileId, audioFiles.find((f) => f.id === fileId)?.filename);

  // One hidden file input serves every row's "New take…" (refs above the
  // early return with the other hooks).
  const pickNewTake = (fileId: string) => {
    if (busy || !takeInputRef.current) return;
    takeForRef.current = fileId;
    takeInputRef.current.value = '';
    takeInputRef.current.click();
  };
  const onTakeChosen = (file: File | undefined) => {
    const fileId = takeForRef.current;
    takeForRef.current = null;
    if (!file || !fileId || !actions) return;
    // Destructive and project-wide: the old take is deleted, and every
    // passage using this file changes.
    if (
      !window.confirm(
        `Replace "${name(fileId)}" with "${file.name}"? Every passage using it will play the new take, and the old take is deleted.`,
      )
    ) {
      return;
    }
    void run(() => actions.newTake(fileId, file));
  };

  const run = async (op: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Whatever's playing may be the clip being swapped out.
    clip.stop();
    mix.stop();
    try {
      await op();
      setPicking(null);
      // Closes the "add a conditional variant" builder back to its
      // button state on success too — without this, the builder
      // stayed open pointing at the already-saved condition, and a
      // second file pick there re-sent the same condition and 409'd
      // (expectEmpty sees the just-created row as "already filled").
      setAddingConditionFor(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the audio');
    } finally {
      setBusy(false);
    }
  };

  const playClip = (id: string, url: string) => {
    mix.stop();
    clip.toggle(id, url);
  };

  // Timing saves don't wait on (or block) other changes: tabbing from one
  // effect's field to the next must save both.
  // Saves for one effect run in order, so an older value can't land
  // after a newer one; different effects still save independently.
  // Resolves to whether the save landed; never rejects.
  const saveOffset = (fileId: string, ms: number | null): Promise<boolean> => {
    setError(null);
    const saves = pendingSavesRef.current;
    const chain = (saves.get(fileId) ?? Promise.resolve(true))
      .then(() => actions!.setSfxOffset(nodeId, fileId, ms))
      .then(
        () => true,
        (e: unknown) => {
          setError(e instanceof Error ? e.message : 'Could not save the timing');
          return false;
        },
      );
    saves.set(fileId, chain);
    void chain.finally(() => {
      if (saves.get(fileId) === chain) saves.delete(fileId);
    });
    return chain;
  };
  // Replacing or removing an effect waits for its timing to be saved, so
  // the timing just typed is the one a replacement carries over.
  // Capped: a save that hangs (a stuck request has no timeout of its own)
  // mustn't hold the whole panel busy.
  // A save that failed stops the replace: carrying on would give the new
  // take the old timing and silently lose what the author just entered.
  // A remove doesn't care: the timing goes with the effect.
  const afterSaves = async (fileId: string, { requireSaved }: { requireSaved: boolean }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pendingSavesRef.current.get(fileId) ?? Promise.resolve(true),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), SAVE_WAIT_CAP_MS);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === false && requireSaved) {
      throw new Error("That effect's timing didn't save, so nothing was changed. Try again.");
    }
  };

  const toggleMix = () => {
    if (mix.playing) {
      mix.stop();
      return;
    }
    clip.stop();
    // Previews the DEFAULT variant for a conditioned slot — a static
    // preview, not a live simulation of which variable-conditioned
    // candidate would actually play.
    const voiceoverDefault = defaultVariant(nodeAudio?.voiceover);
    // Synchronously, inside the click: see useMixAudition.
    mix.play({
      voiceUrl: voiceoverDefault ? src(voiceoverDefault.fileId) : undefined,
      ambienceUrl: ambienceDefault ? src(ambienceDefault.fileId) : undefined,
      sfx: sfx.map((entry) => ({ url: src(entry.fileId), offsetMs: offsets[entry.fileId] })),
      voiceVolume: levels.voiceover / 100,
      ambienceVolume: levels.ambience / 100,
    });
  };

  const rowActions = (key: string, label: string, fileId: string, onClear: () => void) =>
    actions && (
      <>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-disabled={busy}
          onClick={() => pickNewTake(fileId)}
          aria-label={`Upload a new take of ${label} for ${nodeId}`}
          title="Upload a new take of this file, everywhere it's used"
        >
          New take…
        </button>
        {canEdit && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-disabled={busy}
            aria-expanded={picking === key}
            onClick={() => !busy && setPicking(picking === key ? null : key)}
          >
            Replace
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-disabled={busy}
          onClick={() => !busy && onClear()}
          aria-label={`Remove ${label} from ${nodeId}`}
          title="Remove"
        >
          ✕
        </button>
      </>
    );

  return (
    <div className="node-audio-preview">
      <div className="node-audio-header">
        <h4 className="node-audio-title">Audio</h4>
        {canMix && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={toggleMix}
            aria-pressed={mix.playing}
          >
            {mix.playing
              ? '■ Stop mix'
              : ambienceDefault
                ? '▶ Play with ambience'
                : '▶ Play with effects'}
          </button>
        )}
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <ul className="node-audio-list">
        {attachedSlots.map((slot) => {
          const variants = variantsForSlot(nodeAudio, slot.key)!;
          return variants.map((variant, variantIndex) => {
            const fileId = variant.fileId;
            // Distinct from other variants of the same slot/file by
            // index — two conditioned variants could reference the
            // same file under different conditions.
            const rowKey = `${slot.key}:${variantIndex}`;
            const variantLabel = variant.condition
              ? `${slot.label} — when ${describeCondition(variant.condition)}`
              : slot.label;
            return (
              <li key={rowKey} className="node-audio-row">
                <AuditionButton
                  id={`${rowKey}:${fileId}`}
                  url={src(fileId)}
                  label={variantLabel}
                  playingId={clip.playingId}
                  toggle={playClip}
                />
                <span className="node-audio-label">{variantLabel}</span>
                <span className="node-audio-file text-muted">{name(fileId)}</span>
                <span className="node-audio-actions">
                  {rowActions(
                    rowKey,
                    variantLabel.toLowerCase(),
                    fileId,
                    () =>
                      void run(() => actions!.clear(nodeId, slot.key, fileId, variant.condition)),
                  )}
                </span>
                {picking === rowKey && actions && (
                  <FilePicker
                    files={audioFiles}
                    category={slot.category}
                    exclude={[fileId]}
                    confirm="Use"
                    label={`Replacement ${variantLabel.toLowerCase()} for ${nodeId}`}
                    busy={busy}
                    onPick={(to) => void run(() => actions.replace(nodeId, slot.key, fileId, to))}
                    onCancel={() => setPicking(null)}
                  />
                )}
              </li>
            );
          });
        })}
        {canAddCondition &&
          SLOTS.map((slot) => (
            <li key={`add-condition-${slot.key}`} className="node-audio-row">
              <span className="audition-btn-spacer" aria-hidden="true" />
              <span className="node-audio-label text-muted">{slot.label}</span>
              {addingConditionFor === slot.key ? (
                <ConditionVariantBuilder
                  slotLabel={slot.label}
                  category={slot.category}
                  nodeId={nodeId}
                  declaredVariables={declaredVariables}
                  audioFiles={audioFiles}
                  busy={busy}
                  onSubmit={(condition, fileId) =>
                    void run(() => actions!.assign(nodeId, slot.key, fileId, condition))
                  }
                  onCancel={() => setAddingConditionFor(null)}
                />
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setAddingConditionFor(slot.key)}
                >
                  + Add conditional variant…
                </button>
              )}
            </li>
          ))}
        {sfx.map((entry, i) => {
          const fileId = entry.fileId;
          // Index, not fileId — two sfx entries can reference the same
          // file under different conditions (mirrors the single-slot
          // variant rows above).
          const key = `sfx:${i}`;
          const sfxLabel = entry.condition
            ? `SFX ${i + 1} — when ${describeCondition(entry.condition)}`
            : `SFX ${i + 1}`;
          return (
            <li key={key} className="node-audio-row">
              <AuditionButton
                id={key}
                url={src(fileId)}
                label={sfxLabel}
                playingId={clip.playingId}
                toggle={playClip}
              />
              <span className="node-audio-label">{sfxLabel}</span>
              <span className="node-audio-file text-muted">{name(fileId)}</span>
              <span className="node-audio-actions">
                {actions && (
                  <SfxOffsetInput
                    key={fileId}
                    ms={offsets[fileId]}
                    label={`When SFX ${i + 1} plays, in seconds`}
                    onInvalid={() =>
                      setError(
                        'Timing is in seconds into the narration, like 2.5 (0 is as it starts). Leave it empty to play as soon as the passage starts.',
                      )
                    }
                    onSave={(ms) => saveOffset(fileId, ms)}
                  />
                )}
                {rowActions(
                  key,
                  sfxLabel,
                  fileId,
                  () =>
                    void run(async () => {
                      await afterSaves(fileId, { requireSaved: false });
                      await actions!.clear(nodeId, 'sfx', fileId, entry.condition);
                    }),
                )}
              </span>
              {picking === key && actions && (
                <FilePicker
                  files={audioFiles}
                  category="sfx"
                  exclude={sfx.map((s) => s.fileId)}
                  confirm="Use"
                  label={`Replacement for SFX ${i + 1} on ${nodeId}`}
                  busy={busy}
                  onPick={(to) =>
                    void run(async () => {
                      await afterSaves(fileId, { requireSaved: true });
                      await actions.replace(nodeId, 'sfx', fileId, to);
                    })
                  }
                  onCancel={() => setPicking(null)}
                />
              )}
            </li>
          );
        })}
        {canAddCondition && (
          <li className="node-audio-row">
            <span className="audition-btn-spacer" aria-hidden="true" />
            <span className="node-audio-label text-muted">Sound effect</span>
            {addingConditionFor === 'sfx' ? (
              <ConditionVariantBuilder
                slotLabel="Sound effect"
                category="sfx"
                nodeId={nodeId}
                declaredVariables={declaredVariables}
                audioFiles={audioFiles}
                busy={busy}
                exclude={sfx.map((s) => s.fileId)}
                onSubmit={(condition, fileId) =>
                  void run(() => actions!.assign(nodeId, 'sfx', fileId, condition))
                }
                onCancel={() => setAddingConditionFor(null)}
              />
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setAddingConditionFor('sfx')}
              >
                + Add conditional sound effect…
              </button>
            )}
          </li>
        )}
        {canEdit &&
          showEmpty &&
          slotsWithoutDefault.map((slot) => (
            <li key={slot.key} className="node-audio-row">
              <span className="audition-btn-spacer" aria-hidden="true" />
              <span className="node-audio-label">{slot.label}</span>
              <FilePicker
                files={audioFiles}
                category={slot.category}
                exclude={[]}
                confirm="Attach"
                label={`${slot.label} to attach to ${nodeId}`}
                busy={busy}
                onPick={(to) => void run(() => actions!.assign(nodeId, slot.key, to))}
              />
            </li>
          ))}
        {canEdit && showEmpty && (
          <li className="node-audio-row">
            <span className="audition-btn-spacer" aria-hidden="true" />
            <span className="node-audio-label">Sound effect</span>
            <FilePicker
              files={audioFiles}
              category="sfx"
              exclude={sfx.map((s) => s.fileId)}
              confirm="Add"
              label={`Sound effect to add to ${nodeId}`}
              busy={busy}
              onPick={(to) => void run(() => actions!.assign(nodeId, 'sfx', to))}
            />
          </li>
        )}
      </ul>
      {actions && (
        <input
          ref={takeInputRef}
          type="file"
          accept={TAKE_FORMATS}
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => onTakeChosen(e.target.files?.[0])}
        />
      )}
      {canEdit && (
        <button
          type="button"
          className="btn btn-sm btn-ghost node-audio-more"
          aria-expanded={showEmpty}
          onClick={() => setShowEmpty((v) => !v)}
        >
          {showEmpty ? 'Done attaching' : 'Attach audio…'}
        </button>
      )}
    </div>
  );
}

/** A declared variable's value as the author types it, parsed against
 * its declared type. Returns 'invalid' for a number field that isn't
 * a number — a string/bool field can't be invalid (bool is a
 * dropdown, string accepts anything). */
function parseConditionValue(
  text: string,
  type: VariableDeclaration['type'],
): VariableValue | 'invalid' {
  if (type === 'bool') return text === 'true';
  if (type === 'number') {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) ? n : 'invalid';
  }
  return text;
}

/**
 * Builds one new variable-conditioned audio variant: pick a declared
 * variable, an operator (narrowed to what makes sense for that
 * variable's type), a value, then the file to play when the
 * condition holds. Calling onSubmit is the caller's job to turn into
 * an actual assign() — this component only builds the condition +
 * picks the file.
 */
function ConditionVariantBuilder({
  slotLabel,
  category,
  nodeId,
  declaredVariables,
  audioFiles,
  busy,
  onSubmit,
  onCancel,
  // Single-value slots (voiceover/ambience/choice1/choice2) have at
  // most one existing file per slot, so reusing it under a new
  // condition is harmless — callers for those leave this empty. sfx
  // passes every file already in use: its offset is stored keyed by
  // file id alone, so two sfx rows sharing a file id (even under
  // different conditions) would silently share one timing value.
  exclude = [],
}: {
  slotLabel: string;
  category: string;
  nodeId: string;
  declaredVariables: VariableDeclaration[];
  audioFiles: AudioFile[];
  busy: boolean;
  onSubmit: (condition: SimpleCondition, fileId: string) => void;
  onCancel: () => void;
  exclude?: string[];
}) {
  const [variableName, setVariableName] = useState(declaredVariables[0]?.name ?? '');
  const variable = declaredVariables.find((v) => v.name === variableName);
  const operators = variable ? operatorsFor(variable.type) : [];
  const [operator, setOperator] = useState<ComparisonOperator>(operators[0] ?? '==');
  const [valueText, setValueText] = useState('');
  const [valueError, setValueError] = useState(false);
  const [condition, setCondition] = useState<SimpleCondition | null>(null);

  // Picking a different variable resets the operator to a valid one
  // for its type, and clears the value (a leftover "angry" typed for
  // a string variable makes no sense once gold's type is selected).
  const onVariableChange = (name: string) => {
    setVariableName(name);
    const next = declaredVariables.find((v) => v.name === name);
    setOperator((next ? operatorsFor(next.type) : [])[0] ?? '==');
    setValueText('');
    setValueError(false);
  };

  if (declaredVariables.length === 0) return null;

  const confirmCondition = () => {
    if (!variable) return;
    const value = parseConditionValue(valueText, variable.type);
    if (value === 'invalid') {
      setValueError(true);
      return;
    }
    setValueError(false);
    setCondition({ variable: variable.name, operator, value });
  };

  if (condition) {
    return (
      <span className="node-audio-picker-row">
        <span className="text-sm text-muted">when {describeCondition(condition)}, play</span>
        <FilePicker
          files={audioFiles}
          category={category}
          exclude={exclude}
          confirm="Add"
          label={`${slotLabel} to play when ${describeCondition(condition)} on ${nodeId}`}
          busy={busy}
          onPick={(fileId) => onSubmit(condition, fileId)}
          onCancel={() => setCondition(null)}
        />
      </span>
    );
  }

  return (
    <span className="node-audio-picker-row">
      <select
        className="select select-inline"
        value={variableName}
        aria-label={`Variable to condition ${slotLabel} on`}
        onChange={(e) => onVariableChange(e.target.value)}
      >
        {declaredVariables.map((v) => (
          <option key={v.name} value={v.name}>
            {v.name}
          </option>
        ))}
      </select>
      <select
        className="select select-inline"
        value={operator}
        aria-label="Comparison operator"
        onChange={(e) => setOperator(e.target.value as ComparisonOperator)}
      >
        {operators.map((op) => {
          const found = COMPARISON_OPERATORS.find((o) => o.value === op);
          return (
            <option key={op} value={op}>
              {found?.label ?? op}
            </option>
          );
        })}
      </select>
      {variable?.type === 'bool' ? (
        <select
          className="select select-inline"
          value={valueText}
          aria-label="Value"
          onChange={(e) => setValueText(e.target.value)}
        >
          <option value="">Choose…</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          type={variable?.type === 'number' ? 'number' : 'text'}
          className="input input-inline"
          value={valueText}
          placeholder="value"
          aria-label="Value"
          onChange={(e) => {
            setValueText(e.target.value);
            setValueError(false);
          }}
        />
      )}
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled={busy || !valueText}
        onClick={() => {
          if (busy || !valueText) return;
          confirmCondition();
        }}
      >
        Next: pick a file
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
        Cancel
      </button>
      {valueError && (
        <span className="text-sm text-error">
          {variable?.type === 'number' ? 'Enter a number.' : 'Enter a value.'}
        </span>
      )}
    </span>
  );
}

/**
 * Library picker: choose, then confirm. Files of the slot's own category
 * come first so the likely choice is near the top, but every file is
 * offered: categories are set at upload and often left at the default.
 */
function FilePicker({
  files,
  category,
  exclude,
  confirm,
  label,
  busy,
  onPick,
  onCancel,
}: {
  files: AudioFile[];
  category: string;
  exclude: string[];
  confirm: string;
  label: string;
  busy: boolean;
  onPick: (fileId: string) => void;
  onCancel?: () => void;
}) {
  const [choice, setChoice] = useState('');
  const { matching, others } = useMemo(() => {
    const available = files.filter((f) => !exclude.includes(f.id));
    const byName = (a: AudioFile, b: AudioFile) => a.original_name.localeCompare(b.original_name);
    return {
      matching: available.filter((f) => f.category === category).sort(byName),
      others: available.filter((f) => f.category !== category).sort(byName),
    };
  }, [files, exclude, category]);
  // A choice that's no longer offered (it was just attached, or a peer
  // took it) mustn't stay armed behind "Choose a file…".
  const armed =
    choice && (matching.some((f) => f.id === choice) || others.some((f) => f.id === choice))
      ? choice
      : '';
  if (matching.length + others.length === 0) {
    return <span className="text-sm text-muted">Nothing else in the library</span>;
  }
  return (
    <span className="node-audio-picker-row">
      <select
        className="select select-inline node-audio-picker"
        value={armed}
        aria-label={label}
        onChange={(e) => setChoice(e.target.value)}
      >
        <option value="">Choose a file…</option>
        {matching.length > 0 && (
          <optgroup label={`${category[0].toUpperCase()}${category.slice(1)} files`}>
            {matching.map((f) => (
              <option key={f.id} value={f.id}>
                {f.original_name}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label={matching.length > 0 ? 'Other files' : 'All files'}>
            {others.map((f) => (
              <option key={f.id} value={f.id}>
                {f.original_name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled={busy || !armed}
        onClick={() => {
          if (busy || !armed) return;
          setChoice('');
          onPick(armed);
        }}
      >
        {confirm}
      </button>
      {onCancel && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      )}
    </span>
  );
}

/** Seconds into the narration (or after arriving, with none). Saves on
 * blur or Enter; empty means "as the passage starts". */
function SfxOffsetInput({
  ms,
  label,
  onSave,
  onInvalid,
}: {
  ms: number | undefined;
  label: string;
  /** Resolves to whether the save landed. */
  onSave: (ms: number | null) => Promise<boolean>;
  onInvalid: () => void;
}) {
  const saved = formatOffsetSeconds(ms);
  const [text, setText] = useState(saved);
  const inputRef = useRef<HTMLInputElement>(null);
  // Follow the stored value when it changes (this save landing, or a
  // peer's), without remounting, which would drop focus. Leave it alone
  // if the author is mid-edit on something newer.
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (saved === lastSaved.current) return;
    const editing = document.activeElement === inputRef.current;
    // Captured now: the updater may not run until the next render, by
    // which point the ref already holds the new value.
    const previous = lastSaved.current;
    lastSaved.current = saved;
    // Only while none of this field's own saves are still on their way;
    // otherwise a value landing mid-sequence would stand in for the
    // newer one already sent.
    if (pending.current === 0) lastSent.current = ms ?? null;
    setText((current) => (!editing || current === previous ? saved : current));
  }, [saved, ms]);
  // What this field last asked to be saved. Compared against rather than
  // the stored value, which lags while a save is in flight: clearing a
  // value just typed, before its save lands, must still be sent.
  const lastSent = useRef<number | null>(ms ?? null);
  const pending = useRef(0);
  const commit = () => {
    const parsed = parseOffsetSeconds(text);
    if (parsed === 'invalid') {
      onInvalid();
      setText(formatOffsetSeconds(lastSent.current ?? undefined));
      return;
    }
    if (parsed === lastSent.current) return;
    lastSent.current = parsed;
    pending.current += 1;
    void onSave(parsed).then((ok) => {
      pending.current -= 1;
      // A failed save didn't change anything: let the same value be sent
      // again, rather than treating it as already saved.
      if (!ok && lastSent.current === parsed) lastSent.current = ms ?? null;
    });
  };
  return (
    <label className="node-audio-offset">
      <span className="text-sm text-muted">at</span>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className="input"
        value={text}
        placeholder="start"
        title="Seconds into the narration (0 is as it starts). Empty plays as soon as the passage starts."
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <span className="text-sm text-muted">s</span>
    </label>
  );
}
