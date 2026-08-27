// Reported as "stitches don't seem to be reachable", with the editor
// showing `read_email_5 (missing)` in the choice target dropdown.
//
// Ink scopes a bare `-> read_email_5` inside a knot to that knot's
// stitch, but the parser only handled the explicit dot form. Everything
// else kept the bare name while the node itself is
// `<knot>.read_email_5`, so the two never matched.
//
// The symptom is in the FRONTEND, not here: NodeDetail renders
// "(missing)" on exact nodeIdSet membership, and storyHealth's BFS
// skips dangling targets, which is what listed a run of passages as
// unreachable. This backend suite covers the resolution itself; the
// frontend behaviour is covered in storyHealth's own tests.
//
// Note what this suite must NOT claim to guard. validateGraph already
// suffix-matches bare targets, so it never emitted `missing_target`
// for them, and it never emits `unreachable_node` for any id
// containing a dot. Assertions about those two warnings pass with this
// fix reverted, so they would guard nothing.

import { parseInk } from '../ink-parser.js';

describe('bare stitch targets', () => {
  const story = `
== inbox ==
Your inbox.
  * Read the fifth
      -> read_email_5
  * Leave it
      -> END

= read_email_5
The fifth email.
  -> END

== elsewhere ==
Somewhere else.
  -> END
`;

  it('resolves a bare choice target to the knot local stitch', () => {
    const g = parseInk(story, 'id');
    expect(g.nodes['inbox'].choices[0].target).toBe('inbox.read_email_5');
  });

  // The guarantee the frontend depends on: every non-terminal target
  // names a node that actually exists, so an exact-membership check
  // (NodeDetail's dropdown, storyHealth's BFS) can't miss it.
  it('leaves every target naming a real node', () => {
    const g = parseInk(story, 'id');
    const dangling: string[] = [];
    for (const node of Object.values(g.nodes)) {
      const targets = [...node.choices.map((c) => c.target), node.divert].filter(
        (t): t is string => !!t && t !== 'END' && t !== 'DONE',
      );
      for (const t of targets) if (!g.nodes[t]) dangling.push(t);
    }
    expect(dangling).toEqual([]);
  });

  it('resolves a bare divert the same way', () => {
    const g = parseInk(
      `
== inbox ==
Intro.
  -> read_email_5

= read_email_5
The fifth email.
  -> END
`,
      'id',
    );
    expect(g.nodes['inbox'].divert).toBe('inbox.read_email_5');
  });

  // Only targets that resolve to nothing today are touched, so a story
  // that works keeps working.
  it('leaves a target that already names a real node alone', () => {
    const g = parseInk(story, 'id');
    expect(g.nodes['inbox'].choices[1].target).toBe('END');
    const elsewhere = parseInk(
      `
== inbox ==
Intro.
  -> elsewhere

== elsewhere ==
There.
  -> END
`,
      'id',
    );
    expect(elsewhere.nodes['inbox'].divert).toBe('elsewhere');
  });

  // Exact match wins over a same-named local stitch. Strict Ink prefers
  // the stitch; preferring the exact match means no target that
  // resolves today changes where it points.
  it('prefers an existing knot over a same-named local stitch', () => {
    const g = parseInk(
      `
== inbox ==
Intro.
  -> shared

= shared
Local stitch.
  -> END

== shared ==
Top-level knot.
  -> END
`,
      'id',
    );
    expect(g.nodes['inbox'].divert).toBe('shared');
  });

  it('never qualifies END or DONE', () => {
    const g = parseInk(
      `
== inbox ==
Intro.
  * Finish
      -> END
  * Stop
      -> DONE

= END_NOTE
Unused.
  -> END
`,
      'id',
    );
    expect(g.nodes['inbox'].choices.map((c) => c.target)).toEqual(['END', 'DONE']);
  });

  // The dot form kept working — it was the only form that ever did.
  it('still resolves the explicit dot form', () => {
    const g = parseInk(
      `
== inbox ==
Intro.
  -> .read_email_5

= read_email_5
The fifth.
  -> END
`,
      'id',
    );
    expect(g.nodes['inbox'].divert).toBe('inbox.read_email_5');
  });

  // A target naming a stitch of a DIFFERENT knot isn't ours to guess
  // at, so it stays put.
  //
  // Nothing reports it, which is worth knowing: validateGraph
  // suffix-matches (`id.endsWith('.' + target)`) so it emits no
  // missing_target, and unreachable_node is skipped for any dotted id.
  // The story parses with zero warnings and the unresolved target is
  // persisted as written. The build gate is what rejects it, and the
  // editor agrees with the gate because normalizeStoryGraph stops at
  // the same two tiers.
  it('does not reach into another knot to satisfy a bare name', () => {
    const g = parseInk(
      `
== inbox ==
Intro.
  -> far_away

== other ==
Other.

= far_away
Deep.
  -> END
`,
      'id',
    );
    expect(g.nodes['inbox'].divert).toBe('far_away');
  });
});
