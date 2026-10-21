import { describe, it, expect } from 'vitest';
import { isTextBlock, type ContentBlock } from '@wanderline/shared';

// Variable support (DEV-199): isTextBlock is the one runtime function
// in expression-types.ts, and every consumer across backend and
// frontend filters a `ContentBlock[]` through it (twee-emitter.ts,
// story-data-builder.ts's stripAssignmentBlocksForPlayer, several
// editor components). These tests cover its own contract directly,
// since nothing else does.

describe('isTextBlock', () => {
  it('is true for an explicit text block', () => {
    const block: ContentBlock = { kind: 'text', text: 'Hi.', tags: [] };
    expect(isTextBlock(block)).toBe(true);
  });

  it('is false for an assignment block', () => {
    const block: ContentBlock = {
      kind: 'assignment',
      statement: {
        kind: 'assignment',
        name: 'gold',
        operator: '=',
        value: { kind: 'literal', value: 1 },
      },
    };
    expect(isTextBlock(block)).toBe(false);
  });

  it('is true for a pre-DEV-199 item with no kind at all (backward compat)', () => {
    const legacyBlock = { text: 'Old row.', tags: [] } as unknown as ContentBlock;
    expect(isTextBlock(legacyBlock)).toBe(true);
  });

  it('is false for null/undefined rather than throwing', () => {
    // Real callers get this array by casting loosely-typed JSONB
    // `story_graph` data, so the type system's `ContentBlock` promise
    // isn't actually guaranteed at runtime. A malformed element must
    // be filtered out, not crash the whole request.
    expect(isTextBlock(null)).toBe(false);
    expect(isTextBlock(undefined)).toBe(false);
  });

  it('drops null/undefined elements when used as a .filter predicate', () => {
    const content = [
      { kind: 'text', text: 'Before.', tags: [] },
      null,
      undefined,
      {
        kind: 'assignment',
        statement: {
          kind: 'assignment',
          name: 'x',
          operator: '=',
          value: { kind: 'literal', value: 1 },
        },
      },
      { kind: 'text', text: 'After.', tags: [] },
    ] as unknown[];
    expect((content as ContentBlock[]).filter(isTextBlock)).toEqual([
      { kind: 'text', text: 'Before.', tags: [] },
      { kind: 'text', text: 'After.', tags: [] },
    ]);
  });
});
