// Yjs collab-editing test surface. Exposes the shared Doc + Awareness +
// Y namespace on window.__yjsDebug so Cypress e2e specs can drive
// "remote peer" edits deterministically, and renders a small
// text-field wired to a demo Y.Text to give the specs a visible
// binding target.
//
// The DEV check inside this component is a safety net: it stops the
// demo hook + Y.Text binding from running if a caller renders us in
// prod anyway. The actual bundle-size win comes from the guard at
// the USE SITE (ProjectDetailPage.tsx) — Vite constant-folds
// `import.meta.env.DEV ? … : null`, marks the import unused, and
// tree-shakes this module + its transitive yjs imports out of the
// prod bundle entirely.

import { useEffect } from 'react';
import * as Y from 'yjs';
import { useYjs } from '../hooks/useYjs';
import { useYjsTextField } from '../hooks/useYjsTextField';

interface Props {
  projectId: string;
}

export default function YjsDemoField({ projectId }: Props) {
  // Belt-and-braces: even if a caller forgets the DEV guard, this
  // returns null in prod builds. Vite dead-codes the branch.
  if (!import.meta.env.DEV) return null;
  return <YjsDemoFieldInner projectId={projectId} />;
}

function YjsDemoFieldInner({ projectId }: Props) {
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
