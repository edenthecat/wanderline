// inline rename of the project title from the workspace
// toolbar. Click the title → it becomes an input. Enter / blur
// commits; Escape closes the editor without committing (only
// while we haven't yet sent the save — once the PATCH is in
// flight we can't honestly un-send it, so we let it land and the
// parent's `onRenamed` reflects what actually happened on the
// server).
//
// This is NOT an optimistic update: the local title flips to the
// new value only after the PATCH succeeds. If a future iteration
// wants snappier UX, replace the commit() body with a setState
// up-front + rollback-on-error.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { updateProject } from '../api/client';

interface Props {
  projectId: string;
  name: string;
  /** Called with the new name after a successful PATCH. */
  onRenamed: (newName: string) => void;
}

export default function EditableProjectTitle({ projectId, name, onRenamed }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Ref-mirrored saving guard so onChange/onBlur/onKeyDown handlers
  // that fire after we kicked off a save can short-circuit without
  // needing the state update to have flushed yet — without this,
  // disabling the input via `disabled={saving}` fires a blur event
  // before React has re-rendered with `saving=true`, and the blur
  // handler re-enters commit(), producing a second PATCH per save.
  const savingRef = useRef(false);

  // Keep the draft in sync with the parent when an external rename
  // (e.g. another collaborator via a future Y.Doc binding) lands.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEdit() {
    setDraft(name);
    setError(null);
    setEditing(true);
  }

  // Close the editor without persisting. Only safe to call BEFORE
  // commit() has dispatched the PATCH; once the request is in
  // flight, the server-side change is the source of truth and we
  // shouldn't pretend the user undid it.
  const cancel = useCallback(() => {
    setDraft(name);
    setError(null);
    setEditing(false);
  }, [name]);

  const commit = useCallback(async () => {
    // Guard against re-entry. onChange/onBlur/onKeyDown all funnel
    // here, and `disabled={saving}` causes a blur that fires AFTER
    // we kicked off the save but BEFORE setSaving has flushed — so
    // the ref-guard catches the second commit before it dispatches
    // another PATCH.
    if (savingRef.current) return;
    const trimmed = draft.trim();
    if (trimmed === '' || trimmed === name) {
      cancel();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await updateProject(projectId, { name: trimmed });
      // Always sync the parent on success — the server has
      // accepted the rename, so the UI must reflect it (otherwise
      // the next refetch would surprise the user with a name that
      // "appeared from nowhere").
      onRenamed(trimmed);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [draft, name, projectId, onRenamed, cancel]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // If a save is mid-flight we can't actually cancel the PATCH;
      // the server response will close the editor on its own. Just
      // ignore Escape during the saving window so we don't show a
      // stale name and then have it "flip" once the request lands.
      if (savingRef.current) return;
      cancel();
    }
  }

  if (editing) {
    return (
      <div className="editable-title editable-title-editing">
        <input
          ref={inputRef}
          className="editable-title-input"
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={onKeyDown}
          disabled={saving}
          aria-label="Project title"
          data-testid="project-title-input"
        />
        {error && (
          <span className="editable-title-error text-sm text-danger" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <h1
      className="editable-title"
      onClick={startEdit}
      onKeyDown={(e) => {
        // Native <button> activates on both Enter and Space; mirror
        // that here since role="button" + tabIndex={0} promises
        // button keyboard semantics. preventDefault on Space stops
        // the page-scroll the browser would otherwise do.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          startEdit();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Project title: ${name}. Click to rename.`}
      data-testid="project-title"
    >
      {name}
    </h1>
  );
}
