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
