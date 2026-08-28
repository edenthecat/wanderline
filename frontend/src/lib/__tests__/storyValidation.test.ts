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

describe('readValidation', () => {
  it('returns the stored blob when it is there', () => {
    const errors = [{ type: 'syntax_error', message: 'unclosed [' }];
    expect(readValidation(graph({ valid: false, errors, warnings: [] }))).toEqual({
      errors,
      warnings: [],
    });
  });

  // The Ship tab counts these and the Story tab renders them. If the
  // accessor let a missing blob through, one of the two would throw —
  // and the readiness summary links straight into the other.
  it('returns null rather than throwing on a graph without the blob', () => {
    expect(readValidation(graph(undefined))).toBeNull();
    expect(readValidation(graph(null))).toBeNull();
    expect(readValidation(graph({ valid: true }))).toBeNull();
    expect(readValidation(graph({ errors: [], warnings: 'nope' }))).toBeNull();
  });

  it('returns null for no graph at all', () => {
    expect(readValidation(null)).toBeNull();
    expect(readValidation(undefined)).toBeNull();
  });
});
