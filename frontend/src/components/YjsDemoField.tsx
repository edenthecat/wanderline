// minimal proof-of-concept that a text field bound
// to Y.Text correctly mirrors edits across browsers. Rendered only
// when the URL has ?yjsDemo=1 — keeps the experiment off the
// regular editor surface while the wiring matures.
//
// Phase 3 replaces this with the real story-content surfaces;
// nothing here ships to non-debug users.

import { useEffect } from 'react';
import * as Y from 'yjs';
import { useYjs } from '../hooks/useYjs';
import { useYjsTextField } from '../hooks/useYjsTextField';

interface Props {
  projectId: string;
}

export default function YjsDemoField({ projectId }: Props) {
  const { doc, awareness, status } = useYjs(projectId);
  const yText = doc ? doc.getText('demo:projectName') : null;
  const { value, inputRef, onChange } = useYjsTextField(yText);

  // Test-affordance: expose the doc + awareness so cypress can
  // simulate a "remote" edit (write into the bound Y.Text) and a
  // "remote peer" (push an awareness entry under a fake clientID).
  // Real two-peer relay + presence are covered by jest +
  // multi-tab spot-checks; the cypress hooks just exercise the
  // local rendering paths.
  useEffect(() => {
    if (!doc) return;
    // Y is exposed so cypress can build a sibling Doc + applyUpdate
    // back into our doc to simulate a remote peer (the only way to
    // get transaction.local=false on this side, which several specs
    // need to test the "ignore my own writes" path).
    (window as unknown as { __yjsDebug?: unknown }).__yjsDebug = { doc, awareness, Y };
    return () => {
      delete (window as unknown as { __yjsDebug?: unknown }).__yjsDebug;
    };
  }, [doc, awareness]);

  return (
    <aside
      className="yjs-demo-field"
      aria-label="Collaborative editing PoC"
      style={{
        margin: '8px 24px 0',
        padding: '8px 12px',
        border: '1px dashed var(--color-border)',
        borderRadius: 6,
        background: 'var(--color-surface)',
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          color: 'var(--color-text-muted)',
        }}
      >
        <strong>Collab PoC:</strong>
        <span data-testid="yjs-status">{status}</span>
        <input
          ref={inputRef}
          value={value}
          onChange={onChange}
          placeholder="Type in two browsers to test sync"
          aria-label="Yjs demo text field"
          data-testid="yjs-demo-input"
          data-yjs-input="true"
          style={{
            flex: 1,
            padding: '4px 8px',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        />
      </div>
    </aside>
  );
}
