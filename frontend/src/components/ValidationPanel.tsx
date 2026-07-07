import { useState } from 'react';
import type { ValidationMessage, ValidationType } from '../api/client';

interface Props {
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  // When the user clicks on a node reference, scroll the node list to
  // that node and expand it. Optional — if absent the link is plain text.
  onNodeJump?: (nodeId: string) => void;
}

// convert a raw backend ValidationMessage into editor-friendly
// "title + hint" copy. The raw `message` from the parser is shown as
// fallback for unknown types. Hints reference common authoring
// mistakes and link to the Ink writing tutorial.
const INK_DOCS = 'https://github.com/inkle/ink/blob/master/Documentation/WritingWithInk.md';
function humanize(msg: ValidationMessage): { title: string; hint?: string; docs?: string } {
  switch (msg.type as ValidationType) {
    case 'missing_start':
      return {
        title: 'No start node found.',
        hint: 'Add a knot named `start`, or make sure at least one `== knot_name ==` declaration exists before any choices.',
        docs: INK_DOCS,
      };
    case 'missing_target':
      return {
        title: msg.message,
        hint: 'A choice or `-> divert` is pointing at a knot/stitch that isn’t declared. Check spelling, or add the missing `== target ==` knot.',
        docs: INK_DOCS,
      };
    case 'unreachable_node':
      return {
        title: msg.message,
        hint:
          'Nothing in the story diverts or has a choice that lands on this node. Add a `-> ' +
          (msg.nodeId ?? 'name') +
          '` from somewhere reachable, or delete the knot.',
      };
    case 'empty_node':
      return {
        title: msg.message,
        hint: 'This knot has no content, no choices, and no divert — the player will land on it and have nothing to do. Add at least narration text, a `-> next` divert, or `* choice` options.',
      };
    case 'duplicate_node':
      return {
        title: msg.message,
        hint: 'Two declarations share this name. Rename the later one or remove it.',
      };
    case 'orphaned_stitch':
      return {
        title: msg.message,
        hint: 'Stitches (`= name`) must be inside a knot. Move it under a `== knot ==` header, or promote it to its own knot with `==`.',
      };
    case 'circular_reference':
      return {
        title: msg.message,
        hint: 'A chain of diverts leads back to a node already on the stack. Add a choice or break the cycle so the player can exit.',
      };
    case 'syntax_error':
      return {
        title: msg.message,
        hint: 'The parser couldn’t recognize this line. Common causes: an unclosed `[ ]`, a stray `*` not followed by content, or invalid characters in an identifier (letters / digits / underscore only).',
        docs: INK_DOCS,
      };
    default:
      return { title: msg.message };
  }
}

function ItemRow({
  msg,
  severity,
  onNodeJump,
}: {
  msg: ValidationMessage;
  severity: 'error' | 'warning';
  onNodeJump?: (nodeId: string) => void;
}) {
  const h = humanize(msg);
  return (
    <li className={`validation-item validation-item-${severity}`}>
      <div className="validation-item-head">
        <span className="validation-icon" aria-hidden="true">
          {severity === 'error' ? '✖' : '⚠'}
        </span>
        <span className="validation-title">{h.title}</span>
      </div>
      {(msg.nodeId || msg.lineNumber !== undefined) && (
        <div className="validation-meta">
          {msg.lineNumber !== undefined && (
            <span className="validation-line">line {msg.lineNumber}</span>
          )}
          {msg.nodeId && onNodeJump && (
            <button
              type="button"
              className="validation-node-link"
              onClick={() => onNodeJump(msg.nodeId!)}
            >
              {msg.nodeId}
            </button>
          )}
          {msg.nodeId && !onNodeJump && <span className="validation-node-id">{msg.nodeId}</span>}
        </div>
      )}
      {h.hint && <p className="validation-hint">{h.hint}</p>}
      {h.docs && (
        <a className="validation-docs" href={h.docs} target="_blank" rel="noopener noreferrer">
          Ink writing reference →
        </a>
      )}
    </li>
  );
}

/**
 * Covers (unreachable / missing-target warnings) and
 * (syntax errors with line numbers + human-friendly hints). Renders
 * a collapsible card at the top of the Story tab whenever the parsed
 * storyGraph carries any errors or warnings.
 */
export default function ValidationPanel({ errors, warnings, onNodeJump }: Props) {
  const total = errors.length + warnings.length;
  const [open, setOpen] = useState(true);
  if (total === 0) return null;

  const severity: 'error' | 'warning' = errors.length > 0 ? 'error' : 'warning';
  const summary =
    errors.length > 0
      ? `${errors.length} error${errors.length === 1 ? '' : 's'}` +
        (warnings.length > 0
          ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
          : '')
      : `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;

  return (
    <section
      className={`validation-panel validation-panel-${severity}`}
      data-testid="validation-panel"
    >
      <button
        type="button"
        className="validation-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="validation-toggle-icon">{open ? '▼' : '▶'}</span>
        <strong>{summary}</strong>
        <span className="text-muted text-sm">{open ? 'in your story' : '— click to expand'}</span>
      </button>
      {open && (
        <ul className="validation-list">
          {errors.map((e, i) => (
            <ItemRow key={`e${i}`} msg={e} severity="error" onNodeJump={onNodeJump} />
          ))}
          {warnings.map((w, i) => (
            <ItemRow key={`w${i}`} msg={w} severity="warning" onNodeJump={onNodeJump} />
          ))}
        </ul>
      )}
    </section>
  );
}
