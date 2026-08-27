// The user-visible half of the bare-stitch-target bug.
//
// The backend never reported it: validateGraph suffix-matches bare
// targets, so it emitted no missing_target, and it never emits
// unreachable_node for a dotted id. The symptom was here — this BFS
// skips any target that isn't an exact node id, so a knot reached only
// through a bare stitch target was reported unreachable, and
// NodeDetail's dropdown rendered "(missing)" for the same reason.
//
// The parser now qualifies these at parse time, but graphs are stored,
// so the editor resolves them too — same order the backend validator
// and the player have always used.

import { describe, expect, it } from 'vitest';
import { computeStoryHealth } from '../storyHealth';
import type { StoryGraph } from '../../api/client';

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'knot',
  content: [{ text: 'x', tags: [] }],
  choices: [],
  divert: null,
  tags: [],
  ...over,
});

function graph(nodes: Record<string, unknown>): StoryGraph {
  return {
    id: 'g',
    title: 't',
    startNode: 'inbox',
    nodes,
    validation: { errors: [], warnings: [] },
  } as unknown as StoryGraph;
}

describe('storyHealth reachability through stitch targets', () => {
  it('reaches a stitch named by a qualified target', () => {
    const report = computeStoryHealth(
      graph({
        inbox: node('inbox', { choices: [{ text: 'read', target: 'inbox.read_email_5' }] }),
        'inbox.read_email_5': node('inbox.read_email_5', { divert: 'END' }),
      }),
    );
    expect(report.unreachableNodes).not.toContain('inbox.read_email_5');
  });

  // The reported symptom. Story graphs are persisted and nothing
  // re-parses them on read, so a project uploaded before the parser fix
  // still holds bare targets — the walk has to resolve them or those
  // projects keep reporting a working story as unreachable.
  it('reaches a stitch through an unqualified target', () => {
    const report = computeStoryHealth(
      graph({
        inbox: node('inbox', { choices: [{ text: 'read', target: 'read_email_5' }] }),
        'inbox.read_email_5': node('inbox.read_email_5', { divert: 'END' }),
      }),
    );
    expect(report.unreachableNodes).not.toContain('inbox.read_email_5');
  });

  it('still reports a target that names nothing anywhere', () => {
    const report = computeStoryHealth(
      graph({
        inbox: node('inbox', { choices: [{ text: 'go', target: 'nowhere_at_all' }] }),
        'inbox.orphan': node('inbox.orphan', { divert: 'END' }),
      }),
    );
    // Tolerance must not become "everything is reachable".
    expect(report.unreachableNodes).toContain('inbox.orphan');
  });

  it('walks a chain of qualified stitch targets', () => {
    const report = computeStoryHealth(
      graph({
        inbox: node('inbox', { divert: 'inbox.one' }),
        'inbox.one': node('inbox.one', { choices: [{ text: 'on', target: 'inbox.two' }] }),
        'inbox.two': node('inbox.two', { divert: 'END' }),
      }),
    );
    expect(report.unreachableNodes).toEqual([]);
  });
});
