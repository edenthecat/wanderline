// canonical hash + dedup flag.

import { canonicalize, storyHash, useBuildDedup } from '../story-hash.js';

describe('canonicalize', () => {
  it('emits object keys in sorted order regardless of insertion order', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalize({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it('sorts keys at every depth', () => {
    const a = canonicalize({ outer: { z: 1, a: 2 } });
    const b = canonicalize({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order', () => {
    // Story graphs depend on choice order for player behaviour — arrays
    // MUST NOT be sorted, only stringified in-order.
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([3, 1, 2])).not.toBe(canonicalize([1, 2, 3]));
  });

  it('handles primitives verbatim', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('abc')).toBe('"abc"');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
  });

  it('elides undefined object values (matches JSON.stringify)', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('preserves array length by coercing undefined elements to null', () => {
    // JSON.stringify([undefined]) === '[null]' — arrays keep their
    // shape, unlike objects where undefined values elide. Without
    // this coercion `[undefined]` and `[]` would collide.
    expect(canonicalize([undefined])).toBe('[null]');
    expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
    expect(canonicalize([undefined])).not.toBe(canonicalize([]));
  });

  it('deep-equal objects with reordered keys hash to the same string', () => {
    const graph1 = {
      nodes: {
        start: { type: 'knot', choices: [{ text: 'go', target: 'end' }] },
        end: { type: 'knot' },
      },
      startNode: 'start',
    };
    const graph2 = {
      startNode: 'start',
      nodes: {
        end: { type: 'knot' },
        start: { choices: [{ target: 'end', text: 'go' }], type: 'knot' },
      },
    };
    expect(canonicalize(graph1)).toBe(canonicalize(graph2));
  });
});

describe('storyHash', () => {
  it('returns a 64-char lowercase hex sha256', () => {
    const h = storyHash({ hello: 'world' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key orderings', () => {
    expect(storyHash({ a: 1, b: 2 })).toBe(storyHash({ b: 2, a: 1 }));
  });

  it('changes when the graph changes', () => {
    // Sanity: distinct inputs → distinct hashes (collisions with sha256
    // are cosmic-ray-level; a mismatch here would mean canonicalize
    // collapsed something it shouldn't have).
    expect(storyHash({ a: 1 })).not.toBe(storyHash({ a: 2 }));
    expect(storyHash({ a: [1, 2] })).not.toBe(storyHash({ a: [2, 1] }));
  });

  // Regression: content blocks and choices carry a randomUUID() `id`
  // (DEV-199 stable-id rollout) minted fresh on every parse — without
  // stripping it, re-importing byte-identical Ink/Twee source would
  // hash differently every time, defeating build dedup the moment
  // USE_BUILD_DEDUP is on.
  it('ignores content/choice ids so two parses of identical source hash the same', () => {
    const graphA = {
      nodes: {
        start: {
          id: 'start',
          content: [{ id: 'aaaa', kind: 'text', text: 'Hi.', tags: [] }],
          choices: [{ id: 'bbbb', text: 'Go', target: 'END' }],
        },
      },
    };
    const graphB = {
      nodes: {
        start: {
          id: 'start',
          content: [{ id: 'cccc', kind: 'text', text: 'Hi.', tags: [] }],
          choices: [{ id: 'dddd', text: 'Go', target: 'END' }],
        },
      },
    };
    expect(storyHash(graphA)).toBe(storyHash(graphB));
  });

  it('still distinguishes graphs that differ in something other than ids', () => {
    const graphA = {
      nodes: {
        start: { id: 'start', content: [{ id: 'x', kind: 'text', text: 'Hi.', tags: [] }] },
      },
    };
    const graphB = {
      nodes: {
        start: { id: 'start', content: [{ id: 'y', kind: 'text', text: 'Bye.', tags: [] }] },
      },
    };
    expect(storyHash(graphA)).not.toBe(storyHash(graphB));
  });

  // A node's OWN id (its knot/stitch name) is meaningful content, not
  // an incidental randomUUID — renaming a node must still change the
  // hash.
  it('does not strip a node’s own id', () => {
    const graphA = { nodes: { start: { id: 'start', content: [] } } };
    const graphB = { nodes: { start: { id: 'renamed', content: [] } } };
    expect(storyHash(graphA)).not.toBe(storyHash(graphB));
  });

  // Regression (found in review): a Twee passage can legally be
  // named `__proto__` (twee-parser.ts's own `nodes` map already
  // guards against this exact name). stripVolatileIds built its
  // stripped-nodes record as a plain `{}`, so writing a node keyed
  // `__proto__` silently dropped it instead of creating an own
  // property — two graphs differing only in that node's content
  // hashed IDENTICALLY, wrongly treating a real change as a no-op.
  it('does not silently drop a node literally named __proto__', () => {
    // Computed key: the literal `{ __proto__: value }` form would set
    // this object's OWN PROTOTYPE to `value` (since it's an object)
    // instead of creating an own property — `graph.nodes` would then
    // have ZERO own enumerable properties, which defeats this test's
    // whole point rather than exercising it.
    const graphA = {
      nodes: {
        ['__proto__']: { id: '__proto__', content: [{ kind: 'text', text: 'A', tags: [] }] },
      },
    };
    const graphB = {
      nodes: {
        ['__proto__']: { id: '__proto__', content: [{ kind: 'text', text: 'B', tags: [] }] },
      },
    };
    expect(storyHash(graphA)).not.toBe(storyHash(graphB));
  });

  it('throws on null / undefined so an empty story cannot silently collide', () => {
    // Without this guard, canonicalize(null) returns "null" and
    // storyHash(null) = sha256("null") — a real, stable value that
    // every null-story project would share if an upstream guard
    // regressed. Prefer a loud error at the seam.
    expect(() => storyHash(null)).toThrow(/refusing to hash null/);
    expect(() => storyHash(undefined)).toThrow(/refusing to hash null/);
  });
});

describe('useBuildDedup', () => {
  afterEach(() => {
    delete process.env.USE_BUILD_DEDUP;
  });

  it('returns false when unset', () => {
    delete process.env.USE_BUILD_DEDUP;
    expect(useBuildDedup()).toBe(false);
  });

  it('returns true only for the exact string "true"', () => {
    process.env.USE_BUILD_DEDUP = 'true';
    expect(useBuildDedup()).toBe(true);
  });

  it('rejects other truthy strings — explicit opt-in only', () => {
    // Same "no-surprise-on" semantics as USE_SIGNED_URL_DOWNLOADS.
    for (const raw of ['1', 'yes', 'TRUE', 'on']) {
      process.env.USE_BUILD_DEDUP = raw;
      expect(useBuildDedup()).toBe(false);
    }
  });
});
