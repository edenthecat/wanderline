// Author brand-new story variables (DEV-199 Phase 5). Variables
// parsed from uploaded Ink/Twee source already show up read-only
// elsewhere (e.g. NodeAudioPanel's condition builder); this tab is
// the only place to DECLARE one from scratch. Modeled on
// CharactersTab.tsx's create/edit/delete shape, but variables live
// in story_graph.variables (not a separate table), so every mutation
// replaces the whole array via updateVariables — see that function's
// doc comment for why `type` is never sent.

import { useEffect, useState, type FormEvent } from 'react';
import {
  updateVariables,
  printExpression,
  type Expression,
  type StoryGraph,
  type VariableDeclaration,
} from '../api/client';

/** True if `expr` reads `name` anywhere in its tree — used to catch
 * "can't delete X, Y's initial value still depends on it" before
 * sending a save the server would reject with a much less legible
 * evaluator error (variables are evaluated in array order, so a
 * deleted dependency isn't just stale, it's undefined). */
function expressionReferencesVariable(expr: Expression, name: string): boolean {
  switch (expr.kind) {
    case 'literal':
      return false;
    case 'variable':
      return expr.name === name;
    case 'unary':
      return expressionReferencesVariable(expr.operand, name);
    case 'binary':
    case 'logical':
      return (
        expressionReferencesVariable(expr.left, name) ||
        expressionReferencesVariable(expr.right, name)
      );
    case 'listFunction':
    case 'call':
      return expr.args.some((arg) => expressionReferencesVariable(arg, name));
  }
}

interface Props {
  projectId: string;
  storyGraph: StoryGraph | null;
  /** Called after a successful save so the parent's `storyGraph`
   * prop (and every other tab reading it) refetches — matches
   * StoryTab/GraphTab's `onStoryUpdated` pattern. */
  onStoryUpdated?: () => void;
}

interface EditableVariable {
  name: string;
  initialValue: string;
  isConst: boolean;
}

function toEditable(v: VariableDeclaration): EditableVariable {
  return { name: v.name, initialValue: printExpression(v.initialValue), isConst: v.isConst };
}

export default function VariablesTab({ projectId, storyGraph, onStoryUpdated }: Props) {
  const [variables, setVariables] = useState<VariableDeclaration[]>(storyGraph?.variables ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newIsConst, setNewIsConst] = useState(false);

  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editIsConst, setEditIsConst] = useState(false);

  // Re-sync when the parent's storyGraph changes (e.g. a fresh Ink
  // upload replaced the whole story, or our own save round-tripped).
  useEffect(() => {
    setVariables(storyGraph?.variables ?? []);
  }, [storyGraph]);

  async function save(next: EditableVariable[]) {
    setSaving(true);
    setError(null);
    try {
      const result = await updateVariables(projectId, next);
      setVariables(result.story_graph.variables ?? []);
      onStoryUpdated?.();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save variables');
      return false;
    } finally {
      setSaving(false);
    }
  }

  // This tab only ever authors/edits SCALAR variables — a LIST's
  // member universe has no input here and can only be declared via
  // Ink source (see the module doc comment). Every PATCH payload
  // below must exclude existing LIST declarations: printExpression
  // of a LIST's active subset isn't valid syntax to re-parse without
  // the project's LIST context (which this scalar-only route doesn't
  // have), so round-tripping one through `toEditable` would corrupt
  // or outright reject the save (found in review). The server
  // preserves any existing LIST declaration regardless of what this
  // tab submits, so simply omitting it here is sufficient.
  const scalarVariables = variables.filter((v) => v.type !== 'list');

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || !newValue.trim()) return;
    const next = [
      ...scalarVariables.map(toEditable),
      { name, initialValue: newValue, isConst: newIsConst },
    ];
    const ok = await save(next);
    if (ok) {
      setNewName('');
      setNewValue('');
      setNewIsConst(false);
      setShowForm(false);
    }
  }

  function startEdit(v: VariableDeclaration) {
    setEditingName(v.name);
    setEditValue(printExpression(v.initialValue));
    setEditIsConst(v.isConst);
  }

  async function handleUpdate(name: string) {
    if (!editValue.trim()) return;
    const next = scalarVariables.map((v) =>
      v.name === name ? { name, initialValue: editValue, isConst: editIsConst } : toEditable(v),
    );
    const ok = await save(next);
    if (ok) setEditingName(null);
  }

  async function handleDelete(name: string) {
    const dependents = scalarVariables.filter(
      (v) => v.name !== name && expressionReferencesVariable(v.initialValue, name),
    );
    if (dependents.length > 0) {
      setError(
        `Can't delete "${name}" — ${dependents.map((d) => d.name).join(', ')} still ` +
          `reference${dependents.length === 1 ? 's' : ''} it in its initial value. Update ` +
          `${dependents.length === 1 ? 'that variable' : 'those variables'} first.`,
      );
      return;
    }
    if (
      !confirm(`Delete variable "${name}"? Any condition still referencing it will stop matching.`)
    )
      return;
    const next = scalarVariables.filter((v) => v.name !== name).map(toEditable);
    await save(next);
  }

  return (
    <div className="tab-panel">
      <div className="section-header">
        <h2>Variables</h2>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New variable'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {showForm && (
        <form onSubmit={handleCreate} className="card create-form">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              autoFocus
              placeholder="gold"
            />
          </label>
          <label className="field">
            <span className="field-label">Initial value</span>
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              required
              placeholder='10, "Alex", or true'
            />
          </label>
          <label className="field field-checkbox">
            <input
              type="checkbox"
              checked={newIsConst}
              onChange={(e) => setNewIsConst(e.target.checked)}
            />
            <span className="field-label">Constant (can&rsquo;t be changed in-story)</span>
          </label>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Creating...' : 'Create variable'}
          </button>
        </form>
      )}

      {variables.length === 0 ? (
        <div className="empty-state">
          <p>No variables yet.</p>
          <p className="text-muted">
            Variables can gate choice and text visibility, and now also pick which audio clip plays.
          </p>
        </div>
      ) : (
        <div className="character-list">
          {variables.map((v) => (
            <div key={v.name} className="card character-card">
              {editingName === v.name ? (
                <div className="character-edit">
                  <span className="character-name">{v.name}</span>
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="character-edit-name"
                  />
                  <label className="field field-checkbox">
                    <input
                      type="checkbox"
                      checked={editIsConst}
                      onChange={(e) => setEditIsConst(e.target.checked)}
                    />
                    <span className="field-label">Const</span>
                  </label>
                  <div className="character-edit-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleUpdate(v.name)}
                      disabled={saving}
                    >
                      Save
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setEditingName(null)}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : v.type === 'list' ? (
                // Read-only: this tab has no member-list input, and
                // Edit/Delete here would round-trip printExpression's
                // active-subset text back through the scalar-only
                // save route with no LIST context, corrupting or
                // losing the declaration (found in review).
                <div className="character-row">
                  <span className="character-name">{v.name}</span>
                  <span className="badge badge-gray">LIST</span>
                  <span className="text-muted">
                    = {v.listMembers?.join(', ') ?? printExpression(v.initialValue)}
                  </span>
                  <span className="text-muted character-list-readonly-note">
                    Declared in Ink source — edit there
                  </span>
                </div>
              ) : (
                <div className="character-row">
                  <span className="character-name">{v.name}</span>
                  <span className="badge badge-gray">{v.type}</span>
                  {v.isConst && <span className="badge badge-blue">const</span>}
                  <span className="text-muted">= {printExpression(v.initialValue)}</span>
                  <div className="character-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => startEdit(v)}>
                      Edit
                    </button>
                    <button
                      className="btn btn-ghost btn-sm btn-danger"
                      onClick={() => handleDelete(v.name)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
