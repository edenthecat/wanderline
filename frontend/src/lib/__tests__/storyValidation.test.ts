import { describe, expect, it } from 'vitest';
import type { StoryGraph } from '../../api/client';
import { readValidation } from '../storyValidation';

function graph(validation: unknown): StoryGraph {
  return {
    id: 'g1',
    title: 'Story',
    startNode: 'start',
    nodes: {},
    validation,
  } as unknown as StoryGraph;
}

const anError = { type: 'syntax_error', message: 'unclosed [' };

describe('readValidation', () => {
  it('returns the stored blob when it is there', () => {
    expect(readValidation(graph({ valid: false, errors: [anError], warnings: [] }))).toEqual({
      errors: [anError],
      warnings: [],
    });
  });

  // The Ship tab counts these and the Story tab renders them. If the
  // accessor let a missing blob through, one of the two would throw —
  // and the readiness summary links straight into the other.
  it('reports a missing array as unknown rather than throwing', () => {
    expect(readValidation(graph(undefined))).toEqual({ errors: null, warnings: null });
    expect(readValidation(graph(null))).toEqual({ errors: null, warnings: null });
    expect(readValidation(graph({ valid: true }))).toEqual({ errors: null, warnings: null });
  });

  it('returns nulls for no graph at all', () => {
    expect(readValidation(null)).toEqual({ errors: null, warnings: null });
    expect(readValidation(undefined)).toEqual({ errors: null, warnings: null });
  });

  // Per field, not all-or-nothing: real parser errors on a story
  // someone is about to build must not go invisible because the
  // warnings half of the same blob is malformed.
  it('keeps the usable half when only one array is broken', () => {
    expect(readValidation(graph({ errors: [anError], warnings: 'nope' }))).toEqual({
      errors: [anError],
      warnings: null,
    });
    expect(readValidation(graph({ warnings: [] }))).toEqual({ errors: null, warnings: [] });
  });
});
