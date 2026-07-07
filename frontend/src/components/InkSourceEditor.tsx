// CodeMirror 6 editor for raw Ink source. Mounted as a pane inside
// StoryTab and as a slide-in panel inside GraphTab so authors can
// edit + save back to the canonical ink_source from whichever
// workflow they're already in.
//
// The Save button hits POST /projects/:id/ink (see uploadInk in
// the API client) which re-parses the story and invalidates the
// collab room — connected peers reconnect against the fresh story.
// That endpoint also returns a 400 with parser error details when
// the Ink is malformed; we surface that next to the Save button.

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
import { inkLanguage } from '../lib/ink-language';

// Custom highlight style for Ink. defaultHighlightStyle only colors a
// handful of tags and renders our diverts / brackets / separators /
// logic operator as plain text, which buries the structure authors
// actually need to scan for. We map each Ink token to a deliberate
// color so the visual hierarchy reads "knot headings stand out, choices
// and gathers pop, diverts are link-blue, comments fade."
const inkHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: '#7c3aed', fontWeight: '600' },
  { tag: t.keyword, color: '#0891b2' },
  { tag: t.controlKeyword, color: '#16a34a', fontWeight: '600' },
  { tag: t.operator, color: '#d97706' },
  { tag: t.lineComment, color: '#94a3b8', fontStyle: 'italic' },
  { tag: t.link, color: '#2563eb' },
  { tag: t.meta, color: '#db2777' },
  { tag: t.string, color: '#6366f1' },
  { tag: t.bracket, color: '#64748b' },
  { tag: t.separator, color: '#64748b' },
  { tag: t.variableName, color: '#0f172a' },
  { tag: t.number, color: '#b45309' },
]);

interface Props {
  /** Current source loaded from the server. The editor seeds itself
   * with this on mount + on projectId change; subsequent edits live
   * in CodeMirror's internal state until the user clicks Save. Empty
   * string falls through to STARTER_TEMPLATE so a fresh-from-scratch
   * project has somewhere to start. */
  initialSource: string;
  /** Called when the user clicks Save. The component awaits the
   * promise; on success it resets dirty state. On reject the error
   * message renders next to the Save button. */
  onSave: (source: string) => Promise<void>;
  /** Optional close hook for the slide-in panel placement
   * (GraphTab). When null the editor renders without a close
   * affordance — used by the inline StoryTab pane. */
  onClose?: () => void;
  /** Stable across re-renders. Bumping it forces the editor to
   * re-seed from initialSource — used after the parent loads a new
   * project (or as an explicit "discard and replace" gesture; the
   * parent is responsible for confirming with the user first). */
  resetKey?: string | number;
  /** Reported on every dirty-state transition so the parent can
   * gate destructive actions (e.g. file-upload Replace) with a
   * confirmation prompt. */
  onDirtyChange?: (isDirty: boolean) => void;
}

const STARTER_TEMPLATE = `// Welcome to your story. Edit this Ink, then hit Save.

The story begins.

* Step forward -> next_room
* Wait -> END

== next_room ==
You're in a new room.
-> END
`;

export default function InkSourceEditor({
  initialSource,
  onSave,
  onClose,
  resetKey,
  onDirtyChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Track current text in React state so the dirty flag + Save
  // button enable correctly. The editor's own document is the
  // source of truth; this mirrors it on every change.
  const seed = useMemo(() => initialSource || STARTER_TEMPLATE, [initialSource]);
  const [draft, setDraft] = useState(seed);
  const [savedSource, setSavedSource] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Mount CodeMirror once and tear down on unmount. Switching to a
  // new project re-seeds via the resetKey-dependent effect below.
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
          syntaxHighlighting(inkHighlightStyle, { fallback: true }),
          inkLanguage,
          // Tab inserts indentation rather than escaping the editor.
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
    // We intentionally don't include `seed` here — re-seeding is
    // handled by the resetKey effect below so unrelated parent
    // re-renders don't blow away in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-seed in two situations:
  //   1. resetKey changed (parent forced it — project switch OR an
  //      explicit replace gesture like uploading a fresh .ink file).
  //      Force-overwrites local edits because the parent has declared
  //      "throw away whatever's in there."
  //   2. initialSource changed AND the editor is clean (peer save
  //      landed, or our own save came back normalized by the server).
  //      Dirty edits are preserved so the user can resolve on Save.
  // Mirror savedSource/draft to refs in a layout effect so the
  // re-seed effect sees committed values; pre-commit render-time
  // writes are unsafe under concurrent rendering.
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
    // Cheap diff first — only touch the (potentially large) document
    // string when the prop change is actionable.
    const resetKeyChanged = lastResetKeyRef.current !== resetKey;
    lastResetKeyRef.current = resetKey;
    const wasClean = draftRef.current === savedSourceRef.current;
    // Soft path: skip when the editor has unsaved edits. Forced
    // path: parent has declared "throw away whatever's in there"
    // (project switch or a confirmed-by-user replace) so we
    // overwrite even when dirty.
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

  // Surface dirty transitions so parents can gate destructive
  // gestures (e.g. StoryTab confirms before letting a file upload
  // discard the user's unsaved source edits).
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
      setSaveError(err instanceof Error ? err.message : 'Failed to save Ink source');
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
      data-testid="ink-source-editor"
      role="region"
      aria-label="Ink source editor"
    >
      <div className="ink-source-toolbar">
        <div className="ink-source-toolbar-status" aria-live="polite">
          <strong>Ink source</strong>
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
            data-testid="ink-source-save"
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
