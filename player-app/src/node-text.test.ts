import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveNodeEntry } from './node-text';

// DEV-199 follow-up (found in review): nodeText/conditionAllows and
// App.tsx's applyNodeAssignments used to run as two separate,
// mistimed passes — assignments applied first (producing the node's
// FINAL variable store), THEN text visibility checked against that
// final store, rather than against the store as it stood at each
// text block's own point in the passage. resolveNodeEntry fixes this
// by walking content ONCE, in document order, threading a running
// store through both concerns together.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveNodeEntry', () => {
  it('evaluates a text block’s condition against the store as of its OWN point in the passage, not the final store', () => {
    // With `seen` starting false, `{!seen: First visit.}` should show
    // — it's reached BEFORE `~ seen = true` runs — even though by the
    // end of the node `seen` is true.
    const node = {
      content: [
        {
          kind: 'text' as const,
          text: 'First visit.',
          tags: [],
          condition: {
            kind: 'unary' as const,
            operator: '!' as const,
            operand: { kind: 'variable' as const, name: 'seen' },
          },
        },
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'seen',
            operator: '=' as const,
            value: { kind: 'literal' as const, value: true },
          },
        },
        {
          kind: 'text' as const,
          text: 'Welcome back.',
          tags: [],
          condition: { kind: 'variable' as const, name: 'seen' },
        },
      ],
    };
    const { variables, visibleBlocks } = resolveNodeEntry(node, { seen: false });
    expect(visibleBlocks.map((b) => b.text)).toEqual(['First visit.', 'Welcome back.']);
    expect(variables).toEqual({ seen: true });
  });

  it('hides a text block whose condition is still false at its own point, even though a LATER assignment would make it true', () => {
    const node = {
      content: [
        {
          kind: 'text' as const,
          text: 'Too early.',
          tags: [],
          condition: { kind: 'variable' as const, name: 'ready' },
        },
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'ready',
            operator: '=' as const,
            value: { kind: 'literal' as const, value: true },
          },
        },
      ],
    };
    const { visibleBlocks } = resolveNodeEntry(node, { ready: false });
    expect(visibleBlocks).toEqual([]);
  });

  it('returns the same final variable store applyNodeAssignments alone used to return', () => {
    const node = {
      content: [
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'gold',
            operator: '+=' as const,
            value: { kind: 'literal' as const, value: 10 },
          },
        },
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'gold',
            operator: '*=' as const,
            value: { kind: 'literal' as const, value: 2 },
          },
        },
      ],
    };
    const { variables } = resolveNodeEntry(node, { gold: 5 });
    expect(variables).toEqual({ gold: 30 });
  });

  it('respects a conditioned assignment block’s own condition against the running store', () => {
    const node = {
      content: [
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'gold',
            operator: '=' as const,
            value: { kind: 'literal' as const, value: 1 },
          },
          condition: { kind: 'variable' as const, name: 'far' },
        },
      ],
    };
    expect(resolveNodeEntry(node, { gold: 5, far: false }).variables).toEqual({
      gold: 5,
      far: false,
    });
    expect(resolveNodeEntry(node, { gold: 5, far: true }).variables).toEqual({
      gold: 1,
      far: true,
    });
  });

  it('an explicit transcript is not resolved here — callers combine it with visibleBlocks themselves', () => {
    // resolveNodeEntry only concerns itself with content; the
    // transcript-override short-circuit lives in callers (nodeText,
    // App.tsx's passageText) since it's a NODE-level property
    // unrelated to walking content in order.
    const node = { content: [{ kind: 'text' as const, text: 'Ink prose.', tags: [] }] };
    expect(resolveNodeEntry(node, {}).visibleBlocks.map((b) => b.text)).toEqual(['Ink prose.']);
  });

  it('logs and skips a statement that fails, continuing with the rest (same tolerant-degradation as applyNodeAssignments)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = {
      content: [
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'never_declared',
            operator: '+=' as const,
            value: { kind: 'literal' as const, value: 1 },
          },
        },
        {
          kind: 'assignment' as const,
          statement: {
            kind: 'assignment' as const,
            name: 'gold',
            operator: '=' as const,
            value: { kind: 'literal' as const, value: 1 },
          },
        },
      ],
    };
    const { variables } = resolveNodeEntry(node, { gold: 5 });
    expect(variables).toEqual({ gold: 1 });
    expect(warn).toHaveBeenCalled();
  });

  it('returns an empty result for an undefined node', () => {
    expect(resolveNodeEntry(undefined, { gold: 5 })).toEqual({
      variables: { gold: 5 },
      visibleBlocks: [],
    });
  });
});
