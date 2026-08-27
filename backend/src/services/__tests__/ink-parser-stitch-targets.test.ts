// Reported as "stitches don't seem to be reachable", with the editor
// showing `read_email_5 (missing)` in the choice target dropdown.
//
// Ink scopes a bare `-> read_email_5` inside a knot to that knot's
// stitch, but the parser only handled the explicit dot form. Everything
// else kept the bare name while the node itself is
// `<knot>.read_email_5`, so the two never matched: the editor's
// dropdown found no such node, reachability never walked into the
// stitch, and audio coverage — which keys on node ids — saw nothing
// attached. The player masked it by qualifying at runtime, so the
// story played while the editor insisted it was broken.

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

  it('leaves the stitch reachable rather than orphaned', () => {
    const g = parseInk(story, 'id');
    const unreachable = g.validation.warnings
      .filter((w) => w.type === 'unreachable_node')
      .map((w) => w.nodeId);
    expect(unreachable).not.toContain('inbox.read_email_5');
  });

  it('does not report the target as missing', () => {
    const g = parseInk(story, 'id');
    expect(g.validation.warnings.filter((w) => w.type === 'missing_target')).toHaveLength(0);
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
  // at — it stays put and validation reports it.
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
