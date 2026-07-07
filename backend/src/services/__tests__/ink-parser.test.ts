import { parseInk } from '../ink-parser.js';

describe('Ink Parser', () => {
  describe('Knot Detection', () => {
    it('should parse knots with === syntax', () => {
      const source = `
=== start ===
Hello world!
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['start']).toBeDefined();
      expect(result.nodes['start'].type).toBe('knot');
    });

    it('should parse knots with == syntax (no trailing equals)', () => {
      const source = `
== her ==
Some content here.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['her']).toBeDefined();
      expect(result.nodes['her'].type).toBe('knot');
    });

    it('should parse knots with == syntax and no spaces', () => {
      const source = `
==her==
Some content.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['her']).toBeDefined();
    });

    it('should parse multiple knots', () => {
      const source = `
== her ==
First knot.

== tell_you ==
Second knot.

=== i_was_thrown_for_a_loop ===
Third knot with triple equals.
`;
      const result = parseInk(source, 'test-id');
      expect(Object.keys(result.nodes)).toHaveLength(3);
      expect(result.nodes['her']).toBeDefined();
      expect(result.nodes['tell_you']).toBeDefined();
      expect(result.nodes['i_was_thrown_for_a_loop']).toBeDefined();
    });
  });

  describe('Stitch Detection', () => {
    it('should parse stitches within knots', () => {
      const source = `
== tell_you ==
Main content.

= infinite_grace
Stitch content.

= no_reason
Another stitch.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['tell_you']).toBeDefined();
      expect(result.nodes['tell_you.infinite_grace']).toBeDefined();
      expect(result.nodes['tell_you.no_reason']).toBeDefined();
      expect(result.nodes['tell_you.infinite_grace'].type).toBe('stitch');
    });

    it('should handle stitch with content following', () => {
      const source = `
== credits ==
Main credits content.

= actual_credits
written by Someone
code by Another
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['credits.actual_credits']).toBeDefined();
      expect(result.nodes['credits.actual_credits'].content.length).toBeGreaterThan(0);
    });
  });

  describe('Content before first knot', () => {
    it('should create implicit start node for content before first knot', () => {
      const source = `
Hi, whoever's reading this.

I'm a writer.

* Enter site -> her
* Leave site -> credits

== her ==
Some content.

== credits ==
Credits here.
`;
      const result = parseInk(source, 'test-id');
      // Should have an implicit start node
      expect(result.startNode).toBeDefined();
      expect(result.nodes[result.startNode]).toBeDefined();
      // The choices should be attached to the start node
      const startNode = result.nodes[result.startNode];
      expect(startNode.choices.length).toBe(2);
    });
  });

  describe('Choice Parsing', () => {
    it('should parse simple choices with inline diverts', () => {
      const source = `
== start ==
Welcome!

* Enter site -> her
* Leave site -> credits

== her ==
Content.

== credits ==
Credits.
`;
      const result = parseInk(source, 'test-id');
      const startNode = result.nodes['start'];
      expect(startNode.choices.length).toBe(2);
      expect(startNode.choices[0].text).toBe('Enter site');
      expect(startNode.choices[0].target).toBe('her');
      expect(startNode.choices[1].text).toBe('Leave site');
      expect(startNode.choices[1].target).toBe('credits');
    });

    it('should parse choices with bracket syntax', () => {
      const source = `
== start ==
Question?

* [BEFORE] -> END
* [AFTER] -> tell_you

== tell_you ==
Content.
`;
      const result = parseInk(source, 'test-id');
      const startNode = result.nodes['start'];
      expect(startNode.choices.length).toBe(2);
      expect(startNode.choices[0].text).toBe('BEFORE');
      expect(startNode.choices[0].target).toBe('END');
      expect(startNode.choices[1].text).toBe('AFTER');
      expect(startNode.choices[1].target).toBe('tell_you');
    });

    it('should parse choices with divert on next line', () => {
      const source = `
== start ==
Question?

* Do they?
    -> no_reason
* I don't know.
    -> infinite_grace

== no_reason ==
No reason content.

== infinite_grace ==
Infinite grace content.
`;
      const result = parseInk(source, 'test-id');
      const startNode = result.nodes['start'];
      expect(startNode.choices.length).toBe(2);
      expect(startNode.choices[0].text).toBe('Do they?');
      expect(startNode.choices[0].target).toBe('no_reason');
      expect(startNode.choices[1].text).toBe("I don't know.");
      expect(startNode.choices[1].target).toBe('infinite_grace');
    });

    it('should parse indented choices', () => {
      const source = `
== start ==
Content.

    * [First choice] -> one
    * [Second choice] -> two

== one ==
One.

== two ==
Two.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['start'].choices.length).toBe(2);
    });
  });

  describe('Divert Parsing', () => {
    it('should parse standalone diverts', () => {
      const source = `
== start ==
Content.
-> next

== next ==
Next content.
-> END
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['start'].divert).toBe('next');
      expect(result.nodes['next'].divert).toBe('END');
    });

    it('should parse diverts to stitches', () => {
      const source = `
== main ==
Content.
-> main.sub

= sub
Sub content.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['main'].divert).toBe('main.sub');
    });

    // regression: a divert that sits on the line AFTER a choice
    // belongs to that choice, not to the parent knot. Earlier the parser
    // attached the choice target via look-ahead AND re-processed the
    // same line in the main loop, leaving `tell_you.divert = infinite_grace`
    // even though the knot has no top-level fall-through.
    it('does not duplicate a choice divert onto its parent knot', () => {
      const source = `
== tell_you ==
She is interesting.

  * Do they?
      -> no_reason
  * I don't know.
      -> infinite_grace

= infinite_grace
Stuff.
  * I was thrown for a loop.
      -> END

= no_reason
Other stuff.
  * I was thrown for a loop.
      -> END
`;
      const result = parseInk(source, 'test-id');
      const tell = result.nodes['tell_you'];
      expect(tell.choices.map((c) => c.target)).toEqual(['no_reason', 'infinite_grace']);
      // The knot has no unconditional fall-through after the choices —
      // divert must remain null. Previously this was 'infinite_grace'
      // because the look-ahead-consumed line was re-processed.
      expect(tell.divert).toBeNull();
    });

    it('keeps a real fall-through divert that follows the choice block', () => {
      // Sanity: if the author DOES write a knot-level divert after the
      // choices, the parser must still capture it.
      const source = `
== foo ==
Body.
  * Choose A -> a
  * Choose B -> b
-> fallback

== a ==
A
-> END

== b ==
B
-> END

== fallback ==
Fall through
-> END
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['foo'].divert).toBe('fallback');
      expect(result.nodes['foo'].choices.map((c) => c.target)).toEqual(['a', 'b']);
    });
  });

  // a second round of parser fixes covering causes #1–#5 from
  // the ticket. Each describe is one cause.
  describe('Knot declarations with trailing tag/comment (#1)', () => {
    it('accepts a trailing # tag on a knot line', () => {
      const source = `
== her == # author_note
Some content.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['her']).toBeDefined();
      expect(result.nodes['her'].content.length).toBe(1);
    });

    it('accepts a trailing // line comment on a knot line', () => {
      const source = `
== her == // notes to self
Some content.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['her']).toBeDefined();
      expect(result.nodes['her'].content.length).toBe(1);
    });

    it('still rejects garbage trailing tokens on knot lines', () => {
      // Not a knot — sanity that the regex didn't become too lax.
      const source = `
== her bogus ==
Content.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['her']).toBeUndefined();
    });

    // A real project upload had `==== foo ===` with 4 leading
    // equals. Ink's spec allows any ≥ 2; our regex was bounded
    // {2,3} and silently dropped the knot, surfacing as a
    // false-positive "missing target" warning on every choice
    // that pointed at it.
    it('accepts 4+ leading equals on a knot declaration', () => {
      const source = `
==== foo ===
Body.
* -> END
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['foo']).toBeDefined();
      expect(result.nodes['foo'].type).toBe('knot');
    });

    it('accepts asymmetric leading + trailing equals counts', () => {
      const source = `
========= start ==
Body.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['start']).toBeDefined();
    });
  });

  describe('INCLUDE handling (#2)', () => {
    it('emits a validation warning for INCLUDE and keeps parsing the rest', () => {
      const source = `
INCLUDE characters.ink
INCLUDE scenes/intro.ink

== start ==
Hi.
-> END
`;
      const result = parseInk(source, 'test-id');
      // Both INCLUDEs surfaced as warnings — neither silently dropped.
      const includeWarnings = result.validation.warnings.filter((w) =>
        w.message.includes('INCLUDE not supported'),
      );
      expect(includeWarnings.length).toBe(2);
      // The knot AFTER the INCLUDE lines still parses.
      expect(result.nodes['start']).toBeDefined();
      expect(result.nodes['start'].divert).toBe('END');
    });
  });

  describe('Function-knot syntax (#3)', () => {
    it('parses === function foo() === without losing the next knot', () => {
      const source = `
=== function debug_log(msg) ===
~ return msg

=== start ===
Hi.
-> END
`;
      const result = parseInk(source, 'test-id');
      // The function knot exists AND is tagged so author-facing UI can hide it.
      expect(result.nodes['debug_log']).toBeDefined();
      expect(result.nodes['debug_log'].tags).toContain('internal:function');
      // The knot after the function still parses on its own — the
      // previous parser would lose it.
      expect(result.nodes['start']).toBeDefined();
      expect(result.nodes['start'].divert).toBe('END');
    });

    it('parses === function name === without parens', () => {
      const source = `
=== function flag_set ===
~ return true

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['flag_set']).toBeDefined();
      expect(result.nodes['start']).toBeDefined();
    });
  });

  describe('Relative diverts (#4)', () => {
    it('resolves -> .stitch to currentKnot.stitch in a standalone divert', () => {
      const source = `
== main ==
Body.
-> .sub

= sub
Sub content.
-> END
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['main'].divert).toBe('main.sub');
    });

    it('resolves -> .stitch in a choice divert (inline)', () => {
      const source = `
== main ==
Body.
* Pick A -> .a
* Pick B -> .b

= a
A content.
= b
B content.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['main'].choices[0].target).toBe('main.a');
      expect(result.nodes['main'].choices[1].target).toBe('main.b');
    });

    it('resolves -> .stitch in a choice divert (next-line)', () => {
      const source = `
== main ==
Body.
* Pick A
  -> .a

= a
A content.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['main'].choices[0].target).toBe('main.a');
      // And the parent knot should NOT also pick it up (regression).
      expect(result.nodes['main'].divert).toBeNull();
    });
  });

  describe('Choice/gather labels (#5)', () => {
    it('strips a choice label so it does not leak into the choice text', () => {
      const source = `
== start ==
Body.
* (first_choice) Go left -> left
* (second_choice) Go right -> right

== left ==
L.
== right ==
R.
`;
      const result = parseInk(source, 'test-id');
      const cs = result.nodes['start'].choices;
      expect(cs[0].text).toBe('Go left');
      expect(cs[0].target).toBe('left');
      expect(cs[0].tags).toContain('internal:label:first_choice');
      expect(cs[1].text).toBe('Go right');
      expect(cs[1].target).toBe('right');
    });

    it('strips a gather label so it does not leak into gathered content', () => {
      const source = `
== start ==
Body.
* A -> left
* B -> right

== left ==
- (rejoin) Back together now.
-> END

== right ==
- Back together now.
-> END
`;
      const result = parseInk(source, 'test-id');
      // The (rejoin) label is stripped — the gather content reads
      // exactly like the unlabeled version.
      const leftContent = result.nodes['left'].content.map((c) => c.text);
      const rightContent = result.nodes['right'].content.map((c) => c.text);
      expect(leftContent).toEqual(rightContent);
    });
  });

  describe('Validation', () => {
    it('should not warn about END target', () => {
      const source = `
== start ==
Content.
-> END
`;
      const result = parseInk(source, 'test-id');
      expect(result.validation.warnings.filter((w) => w.message.includes('END'))).toHaveLength(0);
    });

    // A real project upload had `== credits ==` with no body, only
    // a stitch `= actual_credits` with content + a divert. Ink runs
    // the first stitch on knot entry, so the parent knot is NOT
    // empty from the author's POV.
    it('does not warn empty_node on a knot that has stitches', () => {
      const source = `
== start ==
Hi.
-> credits

== credits ==

= actual_credits
written by Someone
-> END
`;
      const result = parseInk(source, 'test-id');
      const emptyWarnings = result.validation.warnings.filter((w) => w.type === 'empty_node');
      expect(emptyWarnings.map((w) => w.nodeId)).not.toContain('credits');
    });

    it('still warns empty_node on a truly empty knot', () => {
      // Knot has no content, no choices, no divert, and no stitches.
      const source = `
== start ==
Hi.
-> ghost

== ghost ==
`;
      const result = parseInk(source, 'test-id');
      const emptyWarnings = result.validation.warnings.filter((w) => w.type === 'empty_node');
      expect(emptyWarnings.map((w) => w.nodeId)).toContain('ghost');
    });

    it('should not warn about DONE target', () => {
      const source = `
== start ==
Content.
-> DONE
`;
      const result = parseInk(source, 'test-id');
      expect(result.validation.warnings.filter((w) => w.message.includes('DONE'))).toHaveLength(0);
    });

    it('should find all nodes as reachable when properly connected', () => {
      const source = `
== start ==
Welcome.
* Go to her -> her
* Go to credits -> credits

== her ==
Her content.
-> END

== credits ==
Credits content.
-> END
`;
      const result = parseInk(source, 'test-id');
      const unreachableWarnings = result.validation.warnings.filter(
        (w) => w.type === 'unreachable_node',
      );
      expect(unreachableWarnings).toHaveLength(0);
    });
  });

  describe('Real-world-shaped Ink sample: cave-exploration synthetic', () => {
    // Synthetic fixture exercising the parser branches a real story
    // hits: implicit intro with choices, top-level knots, stitches
    // with relative diverts, `[bracket]` choice syntax (choice text
    // stripped from body), `-> END` and named-knot diverts, gather
    // convergence across sibling stitches, and a credits knot with
    // a stitch trailer. Content is neutral cave exploration — no
    // real narrative, no real names — so the test file can ship
    // with the open-source repo.
    const inkSample = `Welcome, traveler. Something led you to the mouth of an old cave. The wind carries a faint echo from deep inside.

Rusted iron and lichen-covered stone. A path leads inward. Another curves back the way you came.

* Enter the cave -> chamber
* Turn back -> credits

== chamber ==
The passage opens into a wide chamber. Torches gutter along the walls. There's a fork ahead — did the map say LEFT or right at the second turn?

    * [LEFT] -> END
    * [RIGHT] -> passage

== passage ==

The corridor beyond bends downward. A cold breeze rolls up from the depths, carrying the sound of trickling water.

You notice a mural: a river running through a great room. It could be nothing, or it could be a clue about how the chambers connect.

    * Follow the river's carving
        -> wet_route
    * Ignore the mural
        ->dry_route

= dry_route

Ignoring it turns out to be a bad idea. Twenty steps in the corridor becomes a maze of identical branches.

You wander long enough that you start to hear the wind again, and eventually stumble back into a room you recognize.

    * Take a rest by the wall.
        -> rest_stop

= wet_route

The mural sends you along a curving passage. It opens into an antechamber with faint drops of water on the ceiling.

At the far end there's a low arch and, past it, the sound of rushing water.

    * Take a rest by the arch.
        -> rest_stop


=== rest_stop ===

You sit for a while, catching your breath.

The wind picks up. Somewhere further down, a door creaks open by itself.

    * [Follow the sound.]
        -> dead_end

=== dead_end ===

You round the corner and the passage ends abruptly at a smooth stone wall.


== credits ==

* Head home for the night.
    -> actual_credits

= actual_credits
Synthetic Ink fixture for parser tests.
No association with any real narrative.

-> END`;

    it('should parse all knots from the sample', () => {
      const result = parseInk(inkSample, 'test-id', 'Cave Fixture');

      const knotIds = Object.keys(result.nodes).filter((id) => !id.includes('.'));

      // Expected knots: _intro (implicit), chamber, passage,
      // rest_stop, dead_end, credits.
      expect(knotIds).toContain('chamber');
      expect(knotIds).toContain('passage');
      expect(knotIds).toContain('rest_stop');
      expect(knotIds).toContain('dead_end');
      expect(knotIds).toContain('credits');
    });

    it('should parse all stitches from the sample', () => {
      const result = parseInk(inkSample, 'test-id', 'Cave Fixture');

      const stitchIds = Object.keys(result.nodes).filter((id) => id.includes('.'));

      // Expected stitches: passage.dry_route, passage.wet_route,
      // credits.actual_credits.
      expect(stitchIds).toContain('passage.dry_route');
      expect(stitchIds).toContain('passage.wet_route');
      expect(stitchIds).toContain('credits.actual_credits');
    });

    it('should have intro content with choices', () => {
      const result = parseInk(inkSample, 'test-id', 'Cave Fixture');

      const startNode = result.nodes[result.startNode];
      expect(startNode).toBeDefined();
      expect(startNode.choices.length).toBe(2);
      expect(startNode.choices[0].target).toBe('chamber');
      expect(startNode.choices[1].target).toBe('credits');
    });

    it('should have no parsing errors', () => {
      const result = parseInk(inkSample, 'test-id', 'Cave Fixture');
      expect(result.validation.errors).toHaveLength(0);
    });

    it('should correctly link `[bracket]` choices to their targets', () => {
      const result = parseInk(inkSample, 'test-id', 'Cave Fixture');

      // `chamber` uses `[BRACKET]` choice syntax — bracket text
      // becomes the choice.text and is stripped from the body.
      const chamberNode = result.nodes['chamber'];
      expect(chamberNode).toBeDefined();
      expect(chamberNode.choices.length).toBe(2);
      expect(chamberNode.choices[0].text).toBe('LEFT');
      expect(chamberNode.choices[0].target).toBe('END');
      expect(chamberNode.choices[1].text).toBe('RIGHT');
      expect(chamberNode.choices[1].target).toBe('passage');
    });
  });
});
