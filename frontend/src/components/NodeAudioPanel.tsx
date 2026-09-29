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
import { audioFileUrl, type AudioAssignments, type AudioFile } from '../api/client';
import { useAudition } from '../hooks/useAudition';
import { useMixAudition } from '../hooks/useMixAudition';
import type { NodeAudioActions, NodeAudioSlot } from '../hooks/useNodeEditor';
import AuditionButton from './AuditionButton';

type SingleSlot = Exclude<NodeAudioSlot, 'sfx'>;

/** What the server takes for a new take; `audio/*` would offer .m4a,
 * .flac and friends only for them to be refused. */
export const TAKE_FORMATS = '.mp3,.wav,.ogg,.webm,audio/mpeg,audio/wav,audio/ogg,audio/webm';

const SLOTS: { key: SingleSlot; label: string; category: string }[] = [
  { key: 'voiceover', label: 'Voiceover', category: 'voiceover' },
  { key: 'ambience', label: 'Ambience', category: 'ambience' },
  { key: 'choice1', label: 'Choice 1 cue', category: 'choice' },
  { key: 'choice2', label: 'Choice 2 cue', category: 'choice' },
];

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

export default function NodeAudioPanel({
  projectId,
  nodeId,
  nodeAudio,
  audioNames,
  audioFiles = [],
  actions,
  levels = { voiceover: 100, ambience: 50 },
}: Props) {
  const clip = useAudition();
  const mix = useMixAudition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which row's picker is open: a slot key, 'sfx:<fileId>' or 'add-sfx'.
  const [picking, setPicking] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);

  const sfx = nodeAudio?.sfx ?? [];
  const offsets = nodeAudio?.sfxOffsets ?? {};
  const attachedSlots = SLOTS.filter((s) => nodeAudio?.[s.key]);
  const emptySlots = SLOTS.filter((s) => !nodeAudio?.[s.key]);
  const hasAnything = attachedSlots.length > 0 || sfx.length > 0;
  const canEdit = !!actions && audioFiles.length > 0;
  const canMix = !!nodeAudio?.ambience || sfx.length > 0;

  // A peer's change can take away what the mix was playing, and with it
  // the Stop button; don't leave a bed looping with no way to stop it.
  const { stop: stopMix } = mix;
  useEffect(() => {
    if (!canMix) stopMix();
  }, [canMix, stopMix]);

  // Nothing attached and nothing to attach from: stay out of the way, as
  // the read-only preview always did.
  const takeInputRef = useRef<HTMLInputElement>(null);
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
  const saveOffset = (fileId: string, ms: number | null) => {
    setError(null);
    actions!.setSfxOffset(nodeId, fileId, ms).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Could not save the timing');
    });
  };

  const toggleMix = () => {
    if (mix.playing) {
      mix.stop();
      return;
    }
    clip.stop();
    // Synchronously, inside the click: see useMixAudition.
    mix.play({
      voiceUrl: nodeAudio?.voiceover ? src(nodeAudio.voiceover) : undefined,
      ambienceUrl: nodeAudio?.ambience ? src(nodeAudio.ambience) : undefined,
      sfx: sfx.map((id) => ({ url: src(id), offsetMs: offsets[id] })),
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
              : nodeAudio?.ambience
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
          const fileId = nodeAudio![slot.key]!;
          return (
            <li key={slot.key} className="node-audio-row">
              <AuditionButton
                id={`${slot.key}:${fileId}`}
                url={src(fileId)}
                label={slot.label}
                playingId={clip.playingId}
                toggle={playClip}
              />
              <span className="node-audio-label">{slot.label}</span>
              <span className="node-audio-file text-muted">{name(fileId)}</span>
              <span className="node-audio-actions">
                {rowActions(
                  slot.key,
                  slot.label.toLowerCase(),
                  fileId,
                  () => void run(() => actions!.clear(nodeId, slot.key, fileId)),
                )}
              </span>
              {picking === slot.key && actions && (
                <FilePicker
                  files={audioFiles}
                  category={slot.category}
                  exclude={[fileId]}
                  confirm="Use"
                  label={`Replacement ${slot.label.toLowerCase()} for ${nodeId}`}
                  busy={busy}
                  onPick={(to) => void run(() => actions.replace(nodeId, slot.key, fileId, to))}
                  onCancel={() => setPicking(null)}
                />
              )}
            </li>
          );
        })}
        {sfx.map((fileId, i) => {
          const key = `sfx:${fileId}`;
          return (
            <li key={key} className="node-audio-row">
              <AuditionButton
                id={key}
                url={src(fileId)}
                label={`SFX ${i + 1}`}
                playingId={clip.playingId}
                toggle={playClip}
              />
              <span className="node-audio-label">SFX {i + 1}</span>
              <span className="node-audio-file text-muted">{name(fileId)}</span>
              <span className="node-audio-actions">
                {actions && (
                  <SfxOffsetInput
                    key={fileId}
                    ms={offsets[fileId]}
                    label={`When SFX ${i + 1} plays, in seconds`}
                    onInvalid={() =>
                      setError(
                        'Timing is in seconds, like 2.5. Leave it empty to play at the start.',
                      )
                    }
                    onSave={(ms) => saveOffset(fileId, ms)}
                  />
                )}
                {rowActions(
                  key,
                  `SFX ${i + 1}`,
                  fileId,
                  () => void run(() => actions!.clear(nodeId, 'sfx', fileId)),
                )}
              </span>
              {picking === key && actions && (
                <FilePicker
                  files={audioFiles}
                  category="sfx"
                  exclude={sfx}
                  confirm="Use"
                  label={`Replacement for SFX ${i + 1} on ${nodeId}`}
                  busy={busy}
                  onPick={(to) => void run(() => actions.replace(nodeId, 'sfx', fileId, to))}
                  onCancel={() => setPicking(null)}
                />
              )}
            </li>
          );
        })}
        {canEdit &&
          showEmpty &&
          emptySlots.map((slot) => (
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
              exclude={sfx}
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
  onSave: (ms: number | null) => void;
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
    setText((current) => (!editing || current === previous ? saved : current));
  }, [saved]);
  const commit = () => {
    if (text.trim() === saved) return;
    const parsed = parseOffsetSeconds(text);
    if (parsed === 'invalid') {
      onInvalid();
      setText(saved);
      return;
    }
    if (parsed === (ms ?? null)) return;
    onSave(parsed);
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
