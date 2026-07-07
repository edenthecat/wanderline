// CodeMirror editor for raw Twee 3 source. Sibling of
// InkSourceEditor — same dirty/reset/save flow, different language
// mode + save endpoint. A proper generic SourceEditor<T> refactor is
// tempting but out of scope for the Twine epic — this file is a
// deliberate near-duplicate so the two editors evolve independently
// while the ergonomics stay consistent.
//
// Save posts to POST /projects/:id/twine (see uploadTwee in the API
// client), which re-parses the story and invalidates the collab
// room. The endpoint returns a 400 with parser error details when
// the Twee is malformed (or looks like Twee 1); we surface that
// next to the Save button.

import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { highlightSelectionMatches, searchKeymap, search } from '@codemirror/search';
import { tweeLanguage } from '../lib/twee-language';

const tweeHighlightStyle = HighlightStyle.define([
  // `:: Passage` — the strongest structural marker.
  { tag: t.heading, color: '#7c3aed', fontWeight: '600' },
  // Tag list `[tag1 tag2]` in the header.
  { tag: t.attributeName, color: '#d97706' },
  // JSON metadata `{"position":"..."}`.
  { tag: t.meta, color: '#db2777' },
  // Escaped `::` at line start.
  { tag: t.string, color: '#6366f1' },
  // `//` comments.
  { tag: t.lineComment, color: '#94a3b8', fontStyle: 'italic' },
  // `[[Target]]` links.
  { tag: t.link, color: '#2563eb', fontWeight: '500' },
  // `<<macro>>` markers.
  { tag: t.macroName, color: '#0891b2' },
]);

interface Props {
  initialSource: string;
  onSave: (source: string) => Promise<void>;
  onClose?: () => void;
  resetKey?: string | number;
  onDirtyChange?: (isDirty: boolean) => void;
}

const STARTER_TEMPLATE = `:: StoryTitle
My Story

:: StoryData
{"start":"Start"}

:: Start
Welcome. Where do you want to go?

[[Kitchen]]

[[Garage]]

:: Kitchen
Warm and quiet.

:: Garage
Cold. A car sits idle.
`;

export default function TweeSourceEditor({
  initialSource,
  onSave,
  onClose,
  resetKey,
  onDirtyChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const seed = useMemo(() => initialSource || STARTER_TEMPLATE, [initialSource]);
  const [draft, setDraft] = useState(seed);
  const [savedSource, setSavedSource] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: seed,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          bracketMatching(),
          indentOnInput(),
          history(),
          search(),
          syntaxHighlighting(tweeHighlightStyle, { fallback: true }),
          tweeLanguage,
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((upd) => {
            if (upd.docChanged) {
              setDraft(upd.state.doc.toString());
            }
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savedSourceRef = useRef(savedSource);
  const draftRef = useRef(draft);
  useEffect(() => {
    savedSourceRef.current = savedSource;
    draftRef.current = draft;
  });
  const lastResetKeyRef = useRef(resetKey);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const resetKeyChanged = lastResetKeyRef.current !== resetKey;
    lastResetKeyRef.current = resetKey;
    const wasClean = draftRef.current === savedSourceRef.current;
    if (!resetKeyChanged && !wasClean) return;
    const current = view.state.doc.toString();
    if (current === seed) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: seed },
    });
    setDraft(seed);
    setSavedSource(seed);
    setSaveError(null);
  }, [resetKey, seed]);

  const isDirty = draft !== savedSource;

  const lastReportedDirtyRef = useRef(isDirty);
  useEffect(() => {
    if (lastReportedDirtyRef.current === isDirty) return;
    lastReportedDirtyRef.current = isDirty;
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setSavedSource(draft);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save Twee source');
    } finally {
      setSaving(false);
    }
  }

  function handleRevert() {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: savedSource },
    });
    setDraft(savedSource);
    setSaveError(null);
  }

  return (
    <div
      className="ink-source-editor"
      data-testid="twee-source-editor"
      role="region"
      aria-label="Twee source editor"
    >
      <div className="ink-source-toolbar">
        <div className="ink-source-toolbar-status" aria-live="polite">
          <strong>Twee 3 source</strong>
          {isDirty ? (
            <span className="badge badge-amber">Unsaved</span>
          ) : (
            <span className="text-muted text-sm">Saved</span>
          )}
        </div>
        <div className="ink-source-toolbar-actions">
          {isDirty && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleRevert}
              disabled={saving}
            >
              Revert
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSave}
            disabled={!isDirty || saving}
            aria-busy={saving}
            data-testid="twee-source-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {onClose && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              aria-label="Close source editor"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {saveError && (
        <div className="alert alert-error" role="alert">
          {saveError}
        </div>
      )}
      <div ref={hostRef} className="ink-source-host" />
    </div>
  );
}
