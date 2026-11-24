import { parseInk } from '../ink-parser.js';
import { convertStoryGraphToInk } from '../ink-converter.js';
import { isTextBlock } from '../../types.js';
import {
  createFunctionCaller,
  evaluate,
  execute,
  parseExpression,
  parseStatement,
} from '@wanderline/shared';

// Content blocks and choices now carry a randomUUID() `id` (DEV-199
// stable-id rollout) — strips it before comparing parser output
// against a literal fixture, since the exact value is never what
// these tests are checking.
function stripIds<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v) => (key === 'id' ? undefined : v));
}

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
      // Qualified: both are stitches of `tell_you`, and a bare name
      // inside a knot scopes to that knot's stitches. This assertion
      // previously expected the bare names, which is what left the
      // editor showing "(missing)" and reachability skipping them.
      expect(tell.choices.map((c) => c.target)).toEqual([
        'tell_you.no_reason',
        'tell_you.infinite_grace',
      ]);
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

    it('warns when a function-knot shares a name with a LIST_* builtin (found in review)', () => {
      const source = `
=== function LIST_COUNT(x) ===
~ return x * 2

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      // The function-knot still parses — the warning is the only
      // signal that every call to LIST_COUNT(...) will resolve to
      // the builtin, not this knot.
      expect(result.nodes['LIST_COUNT']).toBeDefined();
      expect(
        result.validation.warnings.some(
          (w) => w.message.includes('LIST_COUNT') && w.message.includes('collides with'),
        ),
      ).toBe(true);
    });
  });

  describe('Function-knot params and calls (DEV-199 Phase 10b)', () => {
    it('captures a multi-parameter parameter list on the node', () => {
      const source = `
=== function add(a, b) ===
~ return a + b

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['add'].params).toEqual(['a', 'b']);
    });

    it('a function knot with empty parens gets an empty params array', () => {
      const source = `
=== function noop() ===
~ return 1

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['noop'].params).toEqual([]);
    });

    it('strips a `ref` parameter to its plain name and warns it is unsupported', () => {
      const source = `
=== function bump(ref x) ===
~ return x

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(result.nodes['bump'].params).toEqual(['x']);
      expect(
        result.validation.warnings.some(
          (w) =>
            w.message.includes('bump') && w.message.includes("'ref' parameters are not supported"),
        ),
      ).toBe(true);
    });

    it('parses a call to a function-knot inside a condition, even when the function is declared LATER in the file', () => {
      const source = `
=== start ===
* {double(2) > 3} Go -> next
-> END

=== function double(x) ===
~ return x * 2

=== next ===
Hi.
-> END
`;
      const result = parseInk(source, 'test-id');
      expect(result.validation.errors).toEqual([]);
      const condition = result.nodes['start'].choices[0].condition;
      expect(condition).toEqual({
        kind: 'binary',
        operator: '>',
        left: { kind: 'call', name: 'double', args: [{ kind: 'literal', value: 2 }] },
        right: { kind: 'literal', value: 3 },
      });
    });

    it('parses a call inside an in-content assignment', () => {
      const source = `
=== start ===
~ gold = double(gold)
Hi.

=== function double(x) ===
~ return x * 2
`;
      const result = parseInk(source, 'test-id');
      const [block] = result.nodes['start'].content;
      if (block.kind === 'assignment' && block.statement.kind === 'assignment') {
        expect(block.statement.value).toEqual({
          kind: 'call',
          name: 'double',
          args: [{ kind: 'variable', name: 'gold' }],
        });
      } else {
        throw new Error('expected an assignment block');
      }
    });

    it('parses nested calls f(g(x))', () => {
      const source = `
=== function inc(n) ===
~ return n + 1

=== function double(n) ===
~ return n * 2

=== start ===
~ result = double(inc(1))
Hi.
`;
      const result = parseInk(source, 'test-id');
      const [block] = result.nodes['start'].content;
      if (block.kind === 'assignment' && block.statement.kind === 'assignment') {
        expect(block.statement.value).toEqual({
          kind: 'call',
          name: 'double',
          args: [{ kind: 'call', name: 'inc', args: [{ kind: 'literal', value: 1 }] }],
        });
      } else {
        throw new Error('expected an assignment block');
      }
    });

    it('warns (does not crash) on a call to an undeclared function', () => {
      const source = `
=== start ===
~ x = notReal(1)
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(result.validation.warnings.some((w) => w.message.includes('notReal'))).toBe(true);
    });

    it('warns on a call with the wrong number of arguments', () => {
      const source = `
=== function add(a, b) ===
~ return a + b

=== start ===
~ x = add(1)
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(
        result.validation.warnings.some(
          (w) =>
            w.message.includes("Call to function 'add'") &&
            w.message.includes('1 argument(s)') &&
            w.message.includes('declares 2'),
        ),
      ).toBe(true);
    });

    it('does not warn when the argument count matches', () => {
      const source = `
=== function add(a, b) ===
~ return a + b

=== start ===
~ x = add(1, 2)
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(result.validation.warnings.some((w) => w.message.includes('Call to function'))).toBe(
        false,
      );
    });

    it('parses a self-recursive call with no complaint at parse time', () => {
      const source = `
=== function countdown(n) ===
~ return countdown(n - 1)

=== start ===
~ x = countdown(5)
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(result.validation.errors).toEqual([]);
      expect(result.validation.warnings.some((w) => w.message.includes('countdown'))).toBe(false);
    });

    it('a bare `~ return` with no value parses as a return statement with no value', () => {
      const source = `
=== function sideEffectOnly() ===
~ gold = gold + 1
~ return

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      const last = result.nodes['sideEffectOnly'].content.at(-1);
      expect(last?.kind).toBe('assignment');
      if (last?.kind === 'assignment') {
        expect(last.statement).toEqual({ kind: 'return' });
      }
    });

    it('warns about a choice/divert inside a function-knot rather than silently ignoring it', () => {
      const source = `
=== function broken(x) ===
~ return x
-> END

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(
        result.validation.warnings.some(
          (w) => w.message.includes('broken') && w.message.includes('choice or divert'),
        ),
      ).toBe(true);
    });

    it('does not flag a function-knot as unreachable_node', () => {
      const source = `
=== function helper(x) ===
~ return x

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      expect(
        result.validation.warnings.some(
          (w) => w.type === 'unreachable_node' && w.nodeId === 'helper',
        ),
      ).toBe(false);
    });
  });

  describe('Function-knot evaluation (DEV-199 Phase 10b) — backend validation-time execution', () => {
    // Confirms a condition/assignment containing a function call
    // actually EVALUATES correctly once wired to a real callFunction
    // handler built from the parsed StoryGraph's own nodes — the
    // interpreter itself (createFunctionCaller) has its own
    // dedicated unit tests in player-app/src/function-interpreter.test.ts;
    // these exercise it end-to-end against parseInk's real output.
    function functionCallerFor(result: ReturnType<typeof parseInk>) {
      return createFunctionCaller({
        getFunction: (name) => {
          const node = result.nodes[name];
          if (!node || !node.tags.includes('internal:function')) return undefined;
          return { params: node.params, content: node.content };
        },
      });
    }

    // parseInk doesn't expose its internal `knownFunctions` set on
    // the returned StoryGraph — it only needs it DURING parsing, to
    // recognize `name(args)` as a call. Re-deriving it here from the
    // already-parsed nodes (same `internal:function` tag the real
    // parser uses) is just this test's own way to parse a FRESH,
    // standalone expression/statement string against the same story.
    function knownFunctionsOf(result: ReturnType<typeof parseInk>): Set<string> {
      return new Set(
        Object.values(result.nodes)
          .filter((n) => n.tags.includes('internal:function'))
          .map((n) => n.id),
      );
    }

    it('evaluates a condition containing a function call', () => {
      const source = `
=== function double(x) ===
~ return x * 2

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      const caller = functionCallerFor(result);
      const expr = parseExpression('double(5) > 8', { knownFunctions: knownFunctionsOf(result) });
      expect(evaluate(expr, {}, caller)).toBe(true);
    });

    it('evaluates an assignment that calls a function-knot', () => {
      const source = `
=== function double(x) ===
~ return x * 2

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      const caller = functionCallerFor(result);
      const stmt = parseStatement('gold = double(gold)', {
        knownFunctions: knownFunctionsOf(result),
      });
      expect(execute(stmt, { gold: 5 }, caller)).toEqual({ gold: 10 });
    });

    it('a function with no return statement evaluates without throwing', () => {
      const source = `
=== function sideEffectOnly() ===
~ gold = gold + 1

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      const caller = functionCallerFor(result);
      const stmt = parseStatement('x = sideEffectOnly()', {
        knownFunctions: knownFunctionsOf(result),
      });
      const next = execute(stmt, { gold: 5 }, caller);
      expect(next.gold).toBe(6);
      expect(next.x).toBe('');
    });

    it('a function referencing an undeclared variable throws when actually called, not at parse time', () => {
      const source = `
=== function broken() ===
~ return undeclaredVar

=== start ===
Hi.
`;
      const result = parseInk(source, 'test-id');
      // Parsing succeeds — the parser never checks whether a bare
      // identifier inside a function body is a declared variable,
      // same as everywhere else in this grammar.
      expect(result.validation.errors).toEqual([]);
      const caller = functionCallerFor(result);
      const stmt = parseStatement('x = broken()', { knownFunctions: knownFunctionsOf(result) });
      expect(() => execute(stmt, {}, caller)).toThrow(/Undefined variable/);
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
      const leftContent = result.nodes['left'].content.filter(isTextBlock).map((c) => c.text);
      const rightContent = result.nodes['right'].content.filter(isTextBlock).map((c) => c.text);
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

  describe('VAR/CONST declarations (DEV-199 Phase 1)', () => {
    it('parses a VAR declaration with an inferred number type', () => {
      const result = parseInk('VAR gold = 50\n\n== start ==\nHi.\n-> END\n', 'test-id');
      expect(result.variables).toEqual([
        {
          name: 'gold',
          type: 'number',
          initialValue: { kind: 'literal', value: 50 },
          isConst: false,
        },
      ]);
    });

    it('parses a CONST declaration with isConst true', () => {
      const result = parseInk('CONST max_health = 100\n\n== start ==\nHi.\n', 'test-id');
      expect(result.variables).toEqual([
        {
          name: 'max_health',
          type: 'number',
          initialValue: { kind: 'literal', value: 100 },
          isConst: true,
        },
      ]);
    });

    it('infers string and bool types', () => {
      const result = parseInk(
        'VAR greeting = "hello"\nVAR flag = true\n\n== start ==\nHi.\n',
        'test-id',
      );
      expect(result.variables).toEqual([
        {
          name: 'greeting',
          type: 'string',
          initialValue: { kind: 'literal', value: 'hello' },
          isConst: false,
        },
        {
          name: 'flag',
          type: 'bool',
          initialValue: { kind: 'literal', value: true },
          isConst: false,
        },
      ]);
    });

    it('evaluates an initializer that references an earlier declaration', () => {
      const result = parseInk('VAR a = 5\nVAR b = a * 2\n\n== start ==\nHi.\n', 'test-id');
      expect(result.variables?.[1]).toEqual({
        name: 'b',
        type: 'number',
        initialValue: {
          kind: 'binary',
          operator: '*',
          left: { kind: 'variable', name: 'a' },
          right: { kind: 'literal', value: 2 },
        },
        isConst: false,
      });
    });

    it('does not create an implicit start node for a leading VAR line', () => {
      const result = parseInk('VAR gold = 50\n\n== start ==\nHi.\n-> END\n', 'test-id');
      expect(result.nodes['_intro']).toBeUndefined();
      expect(result.startNode).toBe('start');
    });

    it('warns and skips a VAR whose initializer references an undeclared variable', () => {
      const result = parseInk('VAR b = unknown_var + 1\n\n== start ==\nHi.\n', 'test-id');
      expect(result.variables).toBeUndefined();
      expect(
        result.validation.warnings.some((w) => w.message.includes('Could not determine a type')),
      ).toBe(true);
    });

    it('warns and skips a VAR with an unparseable initializer', () => {
      const result = parseInk('VAR b = $$$\n\n== start ==\nHi.\n', 'test-id');
      expect(result.variables).toBeUndefined();
      expect(result.validation.warnings.some((w) => w.message.includes('Could not parse'))).toBe(
        true,
      );
    });

    it('leaves variables undefined for a story with no declarations', () => {
      const result = parseInk('== start ==\nHi.\n-> END\n', 'test-id');
      expect(result.variables).toBeUndefined();
    });
  });

  describe('In-content `~` assignment (DEV-199 Phase 1)', () => {
    it('interleaves an assignment block between text blocks in document order', () => {
      const source = '== start ==\nBefore.\n~ gold = gold + 10\nAfter.\n-> END\n';
      const result = parseInk(source, 'test-id');
      const content = result.nodes['start'].content;
      expect(stripIds(content)).toEqual([
        { kind: 'text', text: 'Before.', tags: [] },
        {
          kind: 'assignment',
          statement: {
            kind: 'assignment',
            name: 'gold',
            operator: '=',
            value: {
              kind: 'binary',
              operator: '+',
              left: { kind: 'variable', name: 'gold' },
              right: { kind: 'literal', value: 10 },
            },
          },
        },
        { kind: 'text', text: 'After.', tags: [] },
      ]);
    });

    it('parses a compound assignment operator', () => {
      const source = '== start ==\n~ gold += 10\n';
      const result = parseInk(source, 'test-id');
      const [block] = result.nodes['start'].content;
      expect(stripIds(block)).toEqual({
        kind: 'assignment',
        statement: {
          kind: 'assignment',
          name: 'gold',
          operator: '+=',
          value: { kind: 'literal', value: 10 },
        },
      });
    });

    it('places a leading assignment on an implicit start node', () => {
      const source = '~ gold = 0\nHi.\n';
      const result = parseInk(source, 'test-id');
      const content = result.nodes[result.startNode].content;
      expect(stripIds(content[0])).toEqual({
        kind: 'assignment',
        statement: {
          kind: 'assignment',
          name: 'gold',
          operator: '=',
          value: { kind: 'literal', value: 0 },
        },
      });
      expect(stripIds(content[1])).toEqual({ kind: 'text', text: 'Hi.', tags: [] });
    });

    it('falls back to literal text and warns on a `~` line it does not understand yet (e.g. `~ temp x = 5`)', () => {
      // `~ return x` used to be this test's example, back when
      // `return` wasn't understood at all — DEV-199 Phase 10b adds
      // exactly that (see the "return statements" describe block
      // below), so it's no longer a case this test can use. `temp`
      // locals remain unsupported (see function-interpreter.ts's
      // header), so that's the new example.
      const source = '== debug ==\n~ temp x = 5\n';
      const result = parseInk(source, 'test-id');
      const [block] = result.nodes['debug'].content;
      expect(isTextBlock(block)).toBe(true);
      if (isTextBlock(block)) {
        expect(block.text).toBe('~ temp x = 5');
      }
      expect(
        result.validation.warnings.some((w) => w.message.includes('Could not parse assignment')),
      ).toBe(true);
    });

    it('preserves the exact original line (no inserted space) when falling back on a line with no space after `~`', () => {
      const source = '== debug ==\n~temp x=5\n';
      const result = parseInk(source, 'test-id');
      const [block] = result.nodes['debug'].content;
      expect(isTextBlock(block)).toBe(true);
      if (isTextBlock(block)) {
        expect(block.text).toBe('~temp x=5');
      }
    });

    it('round-trips through the shared content array unaffected when no assignment lines are present', () => {
      // Guards against a regression where adding `~` dispatch somehow
      // changes behavior for the overwhelming majority of existing
      // stories that never use it.
      const source = '== start ==\nJust narration.\n-> END\n';
      const result = parseInk(source, 'test-id');
      expect(stripIds(result.nodes['start'].content)).toEqual([
        { kind: 'text', text: 'Just narration.', tags: [] },
      ]);
    });
  });

  describe('Ink conditional text (DEV-199 Phase 3)', () => {
    it('parses a `{condition: text}` line into a TextBlock with its condition', () => {
      const source = '== start ==\n{gold > 10: You have plenty of gold.}\n';
      const result = parseInk(source, 'test-id');
      expect(stripIds(result.nodes['start'].content)).toEqual([
        {
          kind: 'text',
          text: 'You have plenty of gold.',
          tags: [],
          condition: {
            kind: 'binary',
            operator: '>',
            left: { kind: 'variable', name: 'gold' },
            right: { kind: 'literal', value: 10 },
          },
        },
      ]);
    });

    it('interleaves conditional and unconditional lines in document order', () => {
      const source =
        '== start ==\nAlways shown.\n{seen_market: You remember the market.}\nAlso always shown.\n';
      const result = parseInk(source, 'test-id');
      expect(stripIds(result.nodes['start'].content)).toEqual([
        { kind: 'text', text: 'Always shown.', tags: [] },
        {
          kind: 'text',
          text: 'You remember the market.',
          tags: [],
          condition: { kind: 'variable', name: 'seen_market' },
        },
        { kind: 'text', text: 'Also always shown.', tags: [] },
      ]);
    });

    it('preserves a trailing tag on a conditional line', () => {
      const source = '== start ==\n{gold > 10: Rich.} # narrator:smug\n';
      const result = parseInk(source, 'test-id');
      expect(stripIds(result.nodes['start'].content)).toEqual([
        {
          kind: 'text',
          text: 'Rich.',
          tags: ['narrator:smug'],
          condition: {
            kind: 'binary',
            operator: '>',
            left: { kind: 'variable', name: 'gold' },
            right: { kind: 'literal', value: 10 },
          },
        },
      ]);
    });

    it('resolves an inline divert inside the conditional text', () => {
      const source = '== start ==\n{gold > 10: Onward. -> next}\n\n== next ==\nHi.\n';
      const result = parseInk(source, 'test-id');
      const startNode = result.nodes['start'];
      expect(startNode.divert).toBe('next');
      expect(stripIds(startNode.content)).toEqual([
        {
          kind: 'text',
          text: 'Onward.',
          tags: [],
          condition: {
            kind: 'binary',
            operator: '>',
            left: { kind: 'variable', name: 'gold' },
            right: { kind: 'literal', value: 10 },
          },
        },
      ]);
    });

    it('combines logical operators in the condition', () => {
      const source = '== start ==\n{seen_market && gold > 10: Rich and well-travelled.}\n';
      const result = parseInk(source, 'test-id');
      const [block] = result.nodes['start'].content;
      expect(stripIds(block)).toEqual({
        kind: 'text',
        text: 'Rich and well-travelled.',
        tags: [],
        condition: {
          kind: 'logical',
          operator: '&&',
          left: { kind: 'variable', name: 'seen_market' },
          right: {
            kind: 'binary',
            operator: '>',
            left: { kind: 'variable', name: 'gold' },
            right: { kind: 'literal', value: 10 },
          },
        },
      });
    });

    it('falls back to literal text and warns when the condition fails to parse', () => {
      const source = '== start ==\n{$$$: broken}\n';
      const result = parseInk(source, 'test-id');
      const [block] = result.nodes['start'].content;
      expect(isTextBlock(block)).toBe(true);
      if (isTextBlock(block)) {
        expect(block.text).toBe('{$$$: broken}');
        expect(block.condition).toBeUndefined();
      }
      expect(
        result.validation.warnings.some((w) =>
          w.message.includes("Could not parse conditional text's condition"),
        ),
      ).toBe(true);
    });

    it('does not treat a colon-less brace line (Ink alternatives/sequences) as conditional text', () => {
      // {a|b} is a different, unsupported Ink feature (sequences,
      // shuffles, once-only lists) — it must pass through exactly as
      // it did before this phase: inert literal text, no condition.
      const source = '== start ==\n{a|b}\n';
      const result = parseInk(source, 'test-id');
      expect(stripIds(result.nodes['start'].content)).toEqual([
        { kind: 'text', text: '{a|b}', tags: [] },
      ]);
    });
  });

  describe('Ink conditional choice visibility (DEV-199 Phase 4)', () => {
    it('parses a `{condition}` choice prefix into Choice.condition', () => {
      const source =
        '== start ==\nQuestion?\n\n* {gold > 10} Buy something -> shop\n\n== shop ==\nHi.\n';
      const result = parseInk(source, 'test-id');
      const [choice] = result.nodes['start'].choices;
      expect(choice.text).toBe('Buy something');
      expect(choice.target).toBe('shop');
      expect(choice.condition).toEqual({
        kind: 'binary',
        operator: '>',
        left: { kind: 'variable', name: 'gold' },
        right: { kind: 'literal', value: 10 },
      });
    });

    it('ANDs stacked `{c1}{c2}` prefixes into one expression', () => {
      const source =
        '== start ==\nQuestion?\n\n* {gold > 10}{seen_market} Buy something -> shop\n\n== shop ==\nHi.\n';
      const result = parseInk(source, 'test-id');
      const [choice] = result.nodes['start'].choices;
      expect(choice.condition).toEqual({
        kind: 'logical',
        operator: '&&',
        left: {
          kind: 'binary',
          operator: '>',
          left: { kind: 'variable', name: 'gold' },
          right: { kind: 'literal', value: 10 },
        },
        right: { kind: 'variable', name: 'seen_market' },
      });
    });

    it('leaves a choice with no condition prefix without a condition field at all', () => {
      const source = '== start ==\nQuestion?\n\n* Leave -> END\n';
      const result = parseInk(source, 'test-id');
      expect(result.nodes['start'].choices[0]).not.toHaveProperty('condition');
    });

    it('resolves a condition alongside bracket choice-text syntax', () => {
      const source =
        '== start ==\nQuestion?\n\n* {gold > 10} [Buy] You bought it. -> shop\n\n== shop ==\nHi.\n';
      const result = parseInk(source, 'test-id');
      const [choice] = result.nodes['start'].choices;
      expect(choice.text).toBe('Buy');
      expect(choice.condition).toEqual({
        kind: 'binary',
        operator: '>',
        left: { kind: 'variable', name: 'gold' },
        right: { kind: 'literal', value: 10 },
      });
    });

    it('resolves a condition on a divert-on-next-line choice', () => {
      const source =
        '== start ==\nQuestion?\n\n* {gold > 10} Buy something\n    -> shop\n\n== shop ==\nHi.\n';
      const result = parseInk(source, 'test-id');
      const [choice] = result.nodes['start'].choices;
      expect(choice.target).toBe('shop');
      expect(choice.condition).toBeDefined();
    });

    it('preserves document order across conditional and unconditional choices', () => {
      const source =
        '== start ==\nQuestion?\n\n* Leave -> END\n* {gold > 10} Buy something -> shop\n* Look around -> END\n\n== shop ==\nHi.\n';
      const result = parseInk(source, 'test-id');
      const choices = result.nodes['start'].choices;
      expect(choices.map((c) => c.text)).toEqual(['Leave', 'Buy something', 'Look around']);
      expect(choices[0]).not.toHaveProperty('condition');
      expect(choices[1].condition).toBeDefined();
      expect(choices[2]).not.toHaveProperty('condition');
    });

    it('falls back to literal text and warns when the choice condition fails to parse', () => {
      const source = '== start ==\nQuestion?\n\n* {$$$} Buy something -> shop\n\n== shop ==\nHi.\n';
      const result = parseInk(source, 'test-id');
      const [choice] = result.nodes['start'].choices;
      expect(choice.condition).toBeUndefined();
      expect(choice.text).toBe('{$$$} Buy something');
      expect(
        result.validation.warnings.some((w) =>
          w.message.includes('Could not parse choice condition'),
        ),
      ).toBe(true);
    });
  });

  describe('LIST declarations (DEV-199 Phase 10)', () => {
    it('declares a LIST with its members in order and the parenthesized ones active', () => {
      const source = '== start ==\nLIST kettleState = cold, (boiling), recently_boiled\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toEqual([
        {
          name: 'kettleState',
          type: 'list',
          isConst: false,
          listMembers: ['cold', 'boiling', 'recently_boiled'],
          initialValue: {
            kind: 'literal',
            value: {
              kind: 'list',
              origin: 'kettleState',
              items: [{ name: 'boiling', ordinal: 1 }],
              allItems: [
                { name: 'cold', ordinal: 0 },
                { name: 'boiling', ordinal: 1 },
                { name: 'recently_boiled', ordinal: 2 },
              ],
            },
          },
        },
      ]);
    });

    it('declares a LIST with no initially-active members as an empty list', () => {
      const source = '== start ==\nLIST flags = seenIntro, metGuard\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables?.[0].initialValue).toMatchObject({
        kind: 'literal',
        value: { kind: 'list', items: [] },
      });
    });

    it('resolves a bare member name in a LATER condition as a list literal, not an undeclared variable', () => {
      const source =
        '== start ==\nLIST kettleState = cold, (boiling), recently_boiled\n{kettleState == boiling: It is boiling.}\n';
      const result = parseInk(source, 'test-id');
      const [block] = result.nodes['start'].content;
      expect(isTextBlock(block)).toBe(true);
      if (isTextBlock(block)) {
        expect(block.text).toBe('It is boiling.');
        expect(block.condition).toEqual({
          kind: 'binary',
          operator: '==',
          left: { kind: 'variable', name: 'kettleState' },
          right: {
            kind: 'literal',
            value: {
              kind: 'list',
              origin: 'kettleState',
              items: [{ name: 'boiling', ordinal: 1 }],
              allItems: [
                { name: 'cold', ordinal: 0 },
                { name: 'boiling', ordinal: 1 },
                { name: 'recently_boiled', ordinal: 2 },
              ],
            },
          },
        });
      }
    });

    it('resolves a bare member name in a LATER ~ assignment as a list literal', () => {
      const source =
        '== start ==\nLIST kettleState = cold, boiling\n~ kettleState += boiling\nHi.\n';
      const result = parseInk(source, 'test-id');
      const assignmentBlock = result.nodes['start'].content.find((c) => c.kind === 'assignment');
      expect(assignmentBlock).toBeDefined();
      if (assignmentBlock && assignmentBlock.kind === 'assignment') {
        expect(assignmentBlock.statement.value).toMatchObject({
          kind: 'literal',
          value: { kind: 'list', items: [{ name: 'boiling', ordinal: 1 }] },
        });
      }
    });

    it('a LIST declaration before the first knot does not spawn an implicit start node', () => {
      const source = 'LIST kettleState = cold, (boiling)\n\n== start ==\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.nodes['_intro']).toBeUndefined();
      expect(result.startNode).toBe('start');
    });

    it('warns and skips an invalid member name rather than crashing', () => {
      const source = '== start ==\nLIST bad = 1nvalid\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toBeUndefined();
      expect(
        result.validation.warnings.some((w) => w.message.includes('not a valid member name')),
      ).toBe(true);
    });

    it('warns and skips a LIST whose member name collides with an already-declared VAR', () => {
      const source = '== start ==\nVAR cold = 5\nLIST kettleState = cold, boiling\nHi.\n';
      const result = parseInk(source, 'test-id');
      // Only the VAR survives — the colliding LIST is rejected whole.
      expect(result.variables).toEqual([
        {
          name: 'cold',
          type: 'number',
          isConst: false,
          initialValue: { kind: 'literal', value: 5 },
        },
      ]);
      expect(result.validation.warnings.some((w) => w.message.includes('collides with'))).toBe(
        true,
      );
    });

    it('warns and skips a VAR whose name collides with an already-declared LIST member', () => {
      const source = '== start ==\nLIST kettleState = cold, boiling\nVAR cold = 5\nHi.\n';
      const result = parseInk(source, 'test-id');
      // Only the LIST survives.
      expect(result.variables).toHaveLength(1);
      expect(result.variables?.[0].name).toBe('kettleState');
      expect(result.validation.warnings.some((w) => w.message.includes('collides with'))).toBe(
        true,
      );
    });

    it('warns and skips a LIST whose member name collides with a different LIST’s member', () => {
      const source = '== start ==\nLIST a = x, y\nLIST b = y, z\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toHaveLength(1);
      expect(result.variables?.[0].name).toBe('a');
      expect(
        result.validation.warnings.some((w) => w.message.includes('collides with a member of')),
      ).toBe(true);
    });

    it('a VAR that merely references an existing LIST member round-trips as a VAR, not a bogus second LIST declaration', () => {
      const source = '== start ==\nLIST kettleState = cold, (boiling)\nVAR temp = cold\nHi.\n';
      const result = parseInk(source, 'test-id');
      const tempDecl = result.variables?.find((v) => v.name === 'temp');
      expect(tempDecl).toMatchObject({ name: 'temp', type: 'list' });

      const ink = convertStoryGraphToInk(result);
      expect(ink).toContain('LIST kettleState = cold, (boiling)');
      expect(ink).toContain('VAR temp = cold');
      expect(ink).not.toMatch(/LIST temp/);

      // Round-trips back through the parser unchanged.
      const reparsed = parseInk(ink, 'test-id');
      expect(reparsed.variables?.find((v) => v.name === 'temp')).toEqual(tempDecl);
    });

    it('warns and skips a LIST whose OWN name collides with an already-declared VAR', () => {
      const source = '== start ==\nVAR kettleState = 5\nLIST kettleState = cold, boiling\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toHaveLength(1);
      expect(result.variables?.[0]).toMatchObject({ name: 'kettleState', type: 'number' });
      expect(result.validation.warnings.some((w) => w.message.includes('collides with'))).toBe(
        true,
      );
    });

    it('warns and skips a VAR whose OWN name collides with an already-declared LIST', () => {
      const source = '== start ==\nLIST kettleState = cold, boiling\nVAR kettleState = 5\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toHaveLength(1);
      expect(result.variables?.[0]).toMatchObject({ name: 'kettleState', type: 'list' });
      expect(result.validation.warnings.some((w) => w.message.includes('collides with'))).toBe(
        true,
      );
    });

    it('warns and skips a second LIST whose OWN name collides with an already-declared LIST', () => {
      const source =
        '== start ==\nLIST kettleState = cold, boiling\nLIST kettleState = p, q\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toHaveLength(1);
      expect(result.variables?.[0].listMembers).toEqual(['cold', 'boiling']);
      expect(result.validation.warnings.some((w) => w.message.includes('collides with'))).toBe(
        true,
      );
    });

    it('warns and skips a LIST whose OWN name collides with another LIST’s member', () => {
      const source = '== start ==\nLIST a = boiling, y\nLIST boiling = p, q\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toHaveLength(1);
      expect(result.variables?.[0].name).toBe('a');
      expect(result.validation.warnings.some((w) => w.message.includes('collides with'))).toBe(
        true,
      );
    });

    it('warns and skips a LIST member that collides with another already-declared LIST’s OWN name', () => {
      const source = '== start ==\nLIST a = p, q\nLIST b = a, z\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toHaveLength(1);
      expect(result.variables?.[0].name).toBe('a');
      expect(result.validation.warnings.some((w) => w.message.includes('collides with'))).toBe(
        true,
      );
    });

    it('rejects a list literal mixing members from two different LISTs', () => {
      const source = '== start ==\nLIST a = x, y\nLIST b = p, q\n~ temp = (x, p)\nHi.\n';
      const result = parseInk(source, 'test-id');
      // The assignment statement failed to parse, so no assignment
      // block is emitted for it — just the plain text line.
      expect(result.nodes['start'].content.some((c) => c.kind === 'assignment')).toBe(false);
      expect(
        result.validation.warnings.some((w) =>
          w.message.includes('mixes members from different LISTs'),
        ),
      ).toBe(true);
    });

    it('warns and skips a LIST whose own name is also one of its own members', () => {
      const source = '== start ==\nLIST a = a, b\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toBeUndefined();
      expect(
        result.validation.warnings.some((w) =>
          w.message.includes("cannot share the LIST's own name"),
        ),
      ).toBe(true);
    });

    it('warns and skips a LIST with a duplicate member within the same declaration', () => {
      const source = '== start ==\nLIST a = x, x\nHi.\n';
      const result = parseInk(source, 'test-id');
      expect(result.variables).toBeUndefined();
      expect(
        result.validation.warnings.some((w) => w.message.includes('is declared more than once')),
      ).toBe(true);
    });

    it('rejects __proto__/constructor/prototype as a VAR name with a warning (found in review: remote property injection)', () => {
      // `\w+` matches `__proto__` just fine, so an uploaded Ink file
      // could otherwise legally declare `VAR __proto__ = 5`. The
      // null-prototype `state.variableValues` this writes into
      // already makes that write harmless at runtime, but CodeQL's
      // interprocedural analysis can't trace that allocation through
      // this function's `state: ParserState` parameter, so it still
      // flags the write as "remote property injection" — rejecting
      // the name outright up front resolves that locally, and a
      // story variable named one of these would be confusing anyway.
      for (const name of ['__proto__', 'constructor', 'prototype']) {
        const result = parseInk(`== start ==\nVAR ${name} = 5\nHi.\n`, 'test-id');
        expect(result.variables).toBeUndefined();
        expect(
          result.validation.warnings.some((w) =>
            w.message.includes("can't be used as a variable name"),
          ),
        ).toBe(true);
      }
      expect(Object.prototype).not.toHaveProperty('x');
    });

    it('rejects a LIST named __proto__, or with a __proto__ member, with a warning', () => {
      const ownName = parseInk('== start ==\nLIST __proto__ = cold, boiling\nHi.\n', 'test-id');
      expect(ownName.variables).toBeUndefined();
      expect(
        ownName.validation.warnings.some((w) =>
          w.message.includes("can't be used as a variable name"),
        ),
      ).toBe(true);

      const memberName = parseInk(
        '== start ==\nLIST kettleState = cold, __proto__\nHi.\n',
        'test-id',
      );
      expect(memberName.variables).toBeUndefined();
      expect(
        memberName.validation.warnings.some((w) =>
          w.message.includes("can't be used as a member name"),
        ),
      ).toBe(true);
    });
  });
});
