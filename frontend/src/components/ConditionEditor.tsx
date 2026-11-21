// A single inline editor for a choice's or text block's visibility
// condition (DEV-199 Phase 5). Displays the current condition via
// printExpression and edits it as free-text Ink-expression syntax —
// NodeAudioPanel's ConditionVariantBuilder builds conditions from a
// dropdown instead because its conditions can only ever be simple
// variable=value comparisons; this one can express anything
// parseExpression understands (&&, nested comparisons, etc.), which
// a dropdown can't represent, so free text is the right tool here.

import { useState } from 'react';
import {
  parseExpression,
  printExpression,
  ExpressionParseError,
  type Expression,
} from '../api/client';

interface Props {
  value: Expression | null | undefined;
  onSave: (conditionText: string | null) => Promise<void>;
  ariaLabel: string;
}

export default function ConditionEditor({ value, onSave, ariaLabel }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => (value ? printExpression(value) : ''));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setText(value ? printExpression(value) : '');
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      try {
        parseExpression(trimmed);
      } catch (err) {
        setError(err instanceof ExpressionParseError ? err.message : 'Invalid condition');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed.length > 0 ? trimmed : null);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save condition');
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    setError(null);
    try {
      await onSave(null);
      setEditing(false);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear condition');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span className="condition-editor condition-editor-collapsed">
        {value ? (
          <span className="badge badge-blue condition-badge" title={printExpression(value)}>
            if {printExpression(value)}
          </span>
        ) : null}
        <button type="button" className="btn btn-ghost btn-xs" onClick={startEdit}>
          {value ? 'Edit condition' : '+ Condition'}
        </button>
      </span>
    );
  }

  return (
    <span className="condition-editor condition-editor-open">
      <input
        type="text"
        className="input input-inline condition-editor-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. gold > 10 && hasKey"
        aria-label={ariaLabel}
        disabled={saving}
        autoFocus
      />
      <button
        type="button"
        className="btn btn-primary btn-xs"
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      {value && (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={handleClear}
          disabled={saving}
        >
          Clear
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={() => {
          setEditing(false);
          setError(null);
        }}
        disabled={saving}
      >
        Cancel
      </button>
      {error && <span className="text-sm text-danger condition-editor-error">{error}</span>}
    </span>
  );
}
