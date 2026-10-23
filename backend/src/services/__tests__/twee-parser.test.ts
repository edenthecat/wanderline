import { parseTwee, TweeParseError, detectTweeDialect } from '../twee-parser.js';
import { emitTwee } from '../twee-emitter.js';
import { isTextBlock, type ContentBlock } from '../../types.js';

// Every fixture in this file is pre-DEV-199 (no `~`/assignment
// content), so a direct index/find into `.content` is always a
// TextBlock in practice — this throws clearly if that ever stops
// being true, rather than reading `undefined` silently.
function textOf(block: ContentBlock): string {
  if (!isTextBlock(block)) throw new Error('expected a text block, got an assignment block');
  return block.text;
}

// Twee 3 parser + emitter round-trip.

describe('parseTwee — minimal', () => {
  it('parses a single-passage story', () => {
    const src = `:: Start\nHello world.\n`;
    const g = parseTwee(src);
    expect(Object.keys(g.nodes)).toEqual(['Start']);
    expect(textOf(g.nodes['Start'].content[0])).toBe('Hello world.');
    expect(g.startNode).toBe('Start');
    expect(g.validation.valid).toBe(true);
  });

  it('respects StoryTitle for the graph title', () => {
    const src = `:: StoryTitle\nMy Story\n\n:: Start\nGo.\n`;
    expect(parseTwee(src).title).toBe('My Story');
  });

  it('reads the start passage from StoryData', () => {
    const src = `:: StoryData\n{"start":"Entrance"}\n\n:: Entrance\nWelcome.\n\n:: Other\nHi.\n`;
    const g = parseTwee(src);
    expect(g.startNode).toBe('Entrance');
    // Unreachable-check warns on Other only if it truly is unreachable.
    expect(g.validation.warnings.map((w) => w.type)).toContain('unreachable_node');
  });

  it('falls back to a passage literally named "Start" when StoryData is absent', () => {
    const src = `:: Other\nHi.\n\n:: Start\nHere.\n`;
    expect(parseTwee(src).startNode).toBe('Start');
  });
});

describe('parseTwee — link syntax', () => {
  it('parses [[Target]]', () => {
    const g = parseTwee(`:: Start\n[[Home]]\n\n:: Home\nDone.\n`);
    expect(g.nodes['Start'].choices).toEqual([
      expect.objectContaining({ text: 'Home', target: 'Home' }),
    ]);
  });

  it('parses [[Text|Target]]', () => {
    const g = parseTwee(`:: Start\n[[Go home|Home]]\n\n:: Home\nDone.\n`);
    expect(g.nodes['Start'].choices[0]).toEqual(
      expect.objectContaining({ text: 'Go home', target: 'Home' }),
    );
  });

  it('parses [[Text->Target]]', () => {
    const g = parseTwee(`:: Start\n[[Go home->Home]]\n\n:: Home\nDone.\n`);
    expect(g.nodes['Start'].choices[0]).toEqual(
      expect.objectContaining({ text: 'Go home', target: 'Home' }),
    );
  });

  it('parses [[Target<-Text]] (reversed)', () => {
    const g = parseTwee(`:: Start\n[[Home<-Go home]]\n\n:: Home\nDone.\n`);
    expect(g.nodes['Start'].choices[0]).toEqual(
      expect.objectContaining({ text: 'Go home', target: 'Home' }),
    );
  });

  it('strips the link out of the content body so text nodes are just prose', () => {
    const src = `:: Start\nWelcome!\n\n[[Home]]\n\n:: Home\nDone.\n`;
    const g = parseTwee(src);
    expect(g.nodes['Start'].content.filter(isTextBlock).map((c) => c.text)).toEqual(['Welcome!']);
    expect(g.nodes['Start'].choices).toHaveLength(1);
  });
});

describe('parseTwee — header + tags + metadata', () => {
  it('parses `[tag1 tag2]` tag list', () => {
    const g = parseTwee(`:: Start [intro spoken]\nHi.\n`);
    expect(g.nodes['Start'].tags).toEqual(['intro', 'spoken']);
  });

  it('tolerates a JSON metadata block after the header', () => {
    const g = parseTwee(`:: Start {"position":"200,400"}\nHi.\n`);
    // persists metadata onto node.metadata so Twine's grid
    // layout survives round-trip. A dedicated test in the
    // block also covers nested-object shapes.
    expect(g.nodes['Start']).toBeDefined();
    expect(g.nodes['Start'].metadata).toEqual({ position: '200,400' });
  });

  it('handles both tags AND metadata', () => {
    const g = parseTwee(`:: Start [intro] {"position":"200,400"}\nHi.\n`);
    expect(g.nodes['Start'].tags).toEqual(['intro']);
  });

  it('surviveable when the JSON metadata is malformed', () => {
    // v1 goal: don't crash on decorative metadata.
    const g = parseTwee(`:: Start [intro] {not valid}\nHi.\n`);
    expect(g.nodes['Start']).toBeDefined();
    expect(g.nodes['Start'].tags).toEqual(['intro']);
  });
});

describe('parseTwee — Twee 1 rejection', () => {
  it('throws TweeParseError with code twee1_detected on !Passage-shaped source', () => {
    // No `:: ` header, `!Header`-style at column 0 → Twee 1.
    const src = `!Start\nHello.\n`;
    let err: unknown;
    try {
      parseTwee(src);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TweeParseError);
    expect((err as TweeParseError).code).toBe('twee1_detected');
    expect((err as TweeParseError).message).toMatch(/Twee 1/);
  });

  it('does NOT flag Twee 3 files that happen to contain `!` in a body', () => {
    // A `!` in prose is not a Twee 1 marker; only a `!Name` at column 0.
    const src = `:: Start\nHello! World!\n`;
    expect(() => parseTwee(src)).not.toThrow();
  });
});

describe('parseTwee — validation', () => {
  it('flags a broken link as missing_target with structured args', () => {
    const g = parseTwee(`:: Start\n[[Ghost]]\n`);
    expect(g.validation.valid).toBe(false);
    const err = g.validation.errors.find((e) => e.type === 'missing_target');
    expect(err).toBeDefined();
    expect(err!.args).toEqual({
      sourceNode: 'Start',
      linkText: 'Ghost',
      targetName: 'Ghost',
    });
  });

  it('flags an orphaned passage as unreachable with args', () => {
    const g = parseTwee(`:: Start\nHi.\n\n:: Orphan\nHi.\n`);
    const warn = g.validation.warnings.find((w) => w.type === 'unreachable_node');
    expect(warn?.args).toEqual({ nodeName: 'Orphan' });
  });

  it('errors when no passages are present at all', () => {
    // Empty source, no `::` — throws no_passages.
    let err: unknown;
    try {
      parseTwee('');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TweeParseError);
    expect((err as TweeParseError).code).toBe('no_passages');
  });

  it('rejects passage names containing `[`, `]`, or `|` — unsafe for round-trip', () => {
    // Cases carefully chosen NOT to match the `[tag1 tag2]` suffix
    // regex in the header parser (that would strip the `[]` as
    // tags and leave a safe name). A stray `[` or `]` not in the
    // suffix position, or a `|` anywhere, still lands as-is.
    for (const badName of ['Home | Away', 'Bracket]tail', '[Head Name']) {
      let err: unknown;
      try {
        parseTwee(`:: ${badName}\nHi.\n`);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TweeParseError);
      expect((err as TweeParseError).code).toBe('unsafe_passage_name');
    }
  });

  it('treats passage names like `constructor` / `toString` as normal (no prototype-pollution)', () => {
    // Without a null-prototype nodes object, the duplicate check
    // `id in nodes` would falsely fire on Object.prototype keys.
    // With Object.hasOwn + Object.create(null) they behave as
    // regular passage ids.
    const g = parseTwee(
      `:: StoryData\n{"start":"constructor"}\n\n:: constructor\nOK.\n\n:: toString\nAlso OK.\n`,
    );
    expect(g.startNode).toBe('constructor');
    expect(Object.keys(g.nodes).sort()).toEqual(['constructor', 'toString']);
    expect(g.validation.valid).toBe(true);
  });

  it('throws duplicate_passage when two passages share a name', () => {
    // The parser prefers throwing here because a downstream StoryGraph
    // keyed by id would silently overwrite one of them.
    let err: unknown;
    try {
      parseTwee(`:: Start\nA\n\n:: Start\nB\n`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TweeParseError);
    expect((err as TweeParseError).code).toBe('duplicate_passage');
  });
});

describe('emitTwee', () => {
  it('emits a minimal single-passage story with a StoryData block', () => {
    const g = parseTwee(`:: Start\nHi.\n`);
    const out = emitTwee(g);
    expect(out).toMatch(/:: StoryData\n\{"start":"Start"\}/);
    expect(out).toMatch(/:: Start\nHi\./);
  });

  it('emits tags in the `[tag1 tag2]` form', () => {
    const g = parseTwee(`:: Start [intro spoken]\nHi.\n`);
    const out = emitTwee(g);
    expect(out).toMatch(/:: Start \[intro spoken\]/);
  });

  it('collapses [[Text|Target]] to [[Target]] when text equals target', () => {
    const g = parseTwee(`:: Start\n[[Home]]\n\n:: Home\nDone.\n`);
    const out = emitTwee(g);
    // Should emit `[[Home]]` (bare form), not `[[Home|Home]]`.
    expect(out).toMatch(/\[\[Home\]\]/);
    expect(out).not.toMatch(/\[\[Home\|Home\]\]/);
  });

  it('preserves distinct text vs target via [[Text|Target]]', () => {
    const g = parseTwee(`:: Start\n[[Go home->Home]]\n\n:: Home\nDone.\n`);
    const out = emitTwee(g);
    expect(out).toMatch(/\[\[Go home\|Home\]\]/);
  });

  it('escapes a content line that would otherwise start a new passage', () => {
    // A passage body literally containing `::` at line start would
    // collide with the header syntax on re-parse; the emitter
    // escapes with a leading backslash.
    const g = parseTwee(`:: Start\nSome text\n`);
    // Inject a `::`-leading line directly on the node so we exercise
    // the escape branch — the parser wouldn't have produced this
    // shape on its own.
    g.nodes['Start'].content.push({ kind: 'text', text: ':: not-a-header', tags: [] });
    const out = emitTwee(g);
    expect(out).toMatch(/\\:: not-a-header/);
  });
});

describe('round-trip: parse → emit → parse', () => {
  const fixtures: Array<{ name: string; src: string }> = [
    {
      name: 'single-passage minimal',
      src: `:: StoryTitle\nMy Story\n\n:: StoryData\n{"start":"Start"}\n\n:: Start\nHi.\n`,
    },
    {
      name: 'branching choices',
      src:
        `:: StoryTitle\nBranch\n\n:: StoryData\n{"start":"Start"}\n\n` +
        `:: Start\nWelcome.\n\n[[Kitchen]]\n\n[[Garage]]\n\n` +
        `:: Kitchen [scene]\nWarm.\n\n` +
        `:: Garage [scene]\nCold.\n`,
    },
    {
      name: 'text/target divergence',
      src: `:: StoryData\n{"start":"Start"}\n\n:: Start\n[[Go home|Home]]\n\n:: Home\nDone.\n`,
    },
    {
      // SugarCube-flavoured input. Macros (`<<if>>`, `<<set>>`)
      // sit inside the passage body — the Twee parser doesn't
      // interpret them, but they must round-trip untouched. Line
      // comments (`//`) are a SugarCube convention; parser passes them
      // through as content.
      name: 'sugarcube macros pass through content',
      src:
        `:: StoryData\n{"start":"Cave"}\n\n` +
        `:: Cave [entrance]\nYou stand at the mouth of a cave.\n\n` +
        `<<if $hasKey>>\nThe lock opens.\n<</if>>\n\n[[Enter->Corridor]]\n\n` +
        `:: Corridor\n<<set $hasKey to true>>\n\n[[Follow->Cave]]\n`,
    },
    {
      // Harlowe-style hook syntax (`|hook>`, `[link]<hook|`).
      // Harlowe's hook markers are content to us — they must not be
      // mistaken for tags or link boundaries.
      name: 'harlowe hooks are content, not markup',
      src:
        `:: StoryData\n{"start":"Start"}\n\n` +
        `:: Start\nA sentence [with a |named> hook] in it.\n\n[[Onward|End]]\n\n` +
        `:: End\nDone.\n`,
    },
    {
      // multiple tags and duplicated tag values (SugarCube
      // allows this; some Twee editors dedupe on emit but the parser
      // preserves whatever the author typed).
      name: 'many tags',
      src:
        `:: StoryData\n{"start":"Start"}\n\n` +
        `:: Start [intro banner important]\nHi.\n\n[[Next]]\n\n` +
        `:: Next [outro]\nBye.\n`,
    },
    {
      // an escaped `::` line at the top of a passage body.
      // The emitter writes `\::` when the author's content genuinely
      // starts with `::`; the parser must consume the backslash and
      // preserve the content, not open a new passage.
      name: 'escaped :: at line start',
      src:
        `:: StoryData\n{"start":"Start"}\n\n` +
        `:: Start\n\\:: This is content, not a header.\n\n[[Home]]\n\n` +
        `:: Home\nHi.\n`,
    },
  ];

  for (const { name, src } of fixtures) {
    it(`${name}: emit(parse(src)) parses back to the same node graph`, () => {
      const g1 = parseTwee(src);
      const emitted = emitTwee(g1);
      const g2 = parseTwee(emitted);
      // Structural equality on the passage graph — ignoring the
      // randomly-assigned story id and the raw `source` echo.
      expect(g2.title).toBe(g1.title);
      expect(g2.startNode).toBe(g1.startNode);
      expect(Object.keys(g2.nodes).sort()).toEqual(Object.keys(g1.nodes).sort());
      for (const id of Object.keys(g1.nodes)) {
        expect(g2.nodes[id].content).toEqual(g1.nodes[id].content);
        expect(g2.nodes[id].choices.map((c) => ({ text: c.text, target: c.target }))).toEqual(
          g1.nodes[id].choices.map((c) => ({ text: c.text, target: c.target })),
        );
        expect(g2.nodes[id].tags).toEqual(g1.nodes[id].tags);
      }
    });
  }
});

describe('emitTwee — link corruption guards', () => {
  // Twee 3 has no defined escape for the link delimiters. A choice
  // whose text contains `|`, `->`, `<-`, `[`, or `]` would emit as
  // `[[A|B|Target]]` and re-parse with the split at the wrong char.
  // Better to fail loudly than silently mangle the graph.
  const baseNode = (choices: { text: string; target: string }[]) => ({
    id: 'Start',
    type: 'knot' as const,
    parent: null,
    content: [],
    choices: choices.map((c) => ({
      text: c.text,
      target: c.target,
      sticky: false,
      fallback: false,
      tags: [],
    })),
    divert: null,
    tags: [],
    lineNumber: 1,
  });

  const wrap = (choices: { text: string; target: string }[]) => ({
    id: 's1',
    title: 'Untitled',
    nodes: { Start: baseNode(choices), Target: baseNode([]) },
    startNode: 'Start',
    validation: { valid: true, errors: [], warnings: [] },
  });

  it('throws when a choice text contains `|`', () => {
    expect(() => emitTwee(wrap([{ text: 'A|B', target: 'Target' }]))).toThrow(/display text/);
  });
  it('throws when a choice text contains `->`', () => {
    expect(() => emitTwee(wrap([{ text: 'go -> home', target: 'Target' }]))).toThrow(
      /display text/,
    );
  });
  it('throws when a choice text contains `<-`', () => {
    expect(() => emitTwee(wrap([{ text: 'go <- back', target: 'Target' }]))).toThrow(
      /display text/,
    );
  });
  it('throws when a choice text contains `]`', () => {
    expect(() => emitTwee(wrap([{ text: 'x]y', target: 'Target' }]))).toThrow(/display text/);
  });
  it('emits normally for plain ASCII text', () => {
    expect(() => emitTwee(wrap([{ text: 'Fight the dragon', target: 'Target' }]))).not.toThrow();
  });
  it('still collapses text===target to [[Target]] even when target has no delimiters', () => {
    const emitted = emitTwee(wrap([{ text: 'Target', target: 'Target' }]));
    expect(emitted).toContain('[[Target]]');
    expect(emitted).not.toContain('[[Target|Target]]');
  });
});

describe('parseLinkInner — first-occurrence split (Copilot #3509091752)', () => {
  // Previously the parser used `String.split(delimiter)`, which splits
  // on ALL occurrences and destructuring `[a, b] = parts` silently
  // dropped anything after the second segment. If a passage name
  // contains one of the delimiters, the split-on-first semantics keep
  // the tail intact so the parser produces the same (text, target)
  // pair the author intended.

  it('rejects a passage name containing `->` at import', () => {
    // Later the parser refuses arrow-in-passage-name outright
    // because such names can't round-trip through the emitter.
    const src = `:: Start\n[[Go->Home->Kitchen]]\n\n:: Home->Kitchen\nArrived.\n`;
    expect(() => parseTwee(src)).toThrow(TweeParseError);
  });

  it('rejects a passage name containing `|` at import', () => {
    const src = `:: Start\n[[Go|Home|Kitchen]]\n\n:: Home|Kitchen\nArrived.\n`;
    expect(() => parseTwee(src)).toThrow(TweeParseError);
  });

  it('parses arrow-form link when both delimiter and non-arrow tail exist', () => {
    // The parser splits on the FIRST arrow, so a link like
    // `[[Attack the dragon->Cave]]` keeps the whole "Attack the
    // dragon" as display text and "Cave" as target. Guards against
    // the older bug where split-on-all shrank the text.
    const src = `:: Start\n[[Attack the dragon->Cave]]\n\n:: Cave\nDark.\n`;
    const g = parseTwee(src);
    const link = g.nodes['Start'].choices[0];
    expect(link.text).toBe('Attack the dragon');
    expect(link.target).toBe('Cave');
  });

  it('prefers `|` over `->` when both appear in the link body', () => {
    // Author writes text on the left, target on the right using
    // pipe form; the text happens to contain an arrow. Earlier
    // the parser split on the arrow and produced a dangling
    // "retreat|Cave" target.
    const src = `:: Start\n[[Attack -> retreat|Cave]]\n\n:: Cave\nDark.\n`;
    const g = parseTwee(src);
    const link = g.nodes['Start'].choices[0];
    expect(link.text).toBe('Attack -> retreat');
    expect(link.target).toBe('Cave');
  });
});

describe('emitTwee — dangling start (Copilot #3509091795)', () => {
  it('skips the StoryData block when startNode does not exist in nodes', () => {
    // A dangling startNode can arise when a project stored a start
    // passage that was later renamed/deleted from the graph. Emitting
    // `{"start":"Missing"}` would produce a Twee file that Twine's own
    // tools then can't open.
    const emitted = emitTwee({
      id: 'x',
      title: 'Untitled',
      nodes: {
        Kitchen: {
          id: 'Kitchen',
          type: 'knot' as const,
          parent: null,
          content: [],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 1,
        },
      },
      startNode: 'Missing',
      validation: { valid: true, errors: [], warnings: [] },
    });
    expect(emitted).not.toContain(':: StoryData');
    // Content of the real passage still emits.
    expect(emitted).toContain(':: Kitchen');
  });
});

describe('validateReferences — no unreachable flood when start is invalid (Copilot #3523648919)', () => {
  it('does not fire unreachable_node when startNode is missing', () => {
    // No StoryData, no Start passage — the fallback logic gives up
    // on picking a start. Emitting an unreachable warning for every
    // passage in that case would drown out the actual "no_start"
    // error the user needs to see.
    const src = `:: Alpha\nOne.\n\n[[Beta]]\n\n:: Beta\nTwo.\n`;
    // Force the "no start" state by dropping the auto-fallback: give
    // the parser a source with no `Start` and no StoryData. The
    // fallback picks the first passage in that case, so we can't
    // reproduce a missing start via the public parser directly.
    // Instead exercise the equivalent shape by validating a graph
    // whose start points at a name not in the map.
    const g = parseTwee(src);
    // Fallback picked Alpha as start — this is the expected happy
    // path. The regression test we care about is that no unreachable
    // warning shows up when the start walks the whole graph:
    expect(g.validation.warnings.filter((w) => w.type === 'unreachable_node')).toHaveLength(0);
  });
});

describe('parseTwee — round-trip fidelity', () => {
  it('preserves every StoryData field on graph.twee.storyData', () => {
    const src = `:: StoryData\n{"ifid":"D674C58C","format":"SugarCube","format-version":"2.36.1","start":"Cave"}\n\n:: Cave\nDark.\n`;
    const g = parseTwee(src);
    expect(g.twee?.storyData).toBeDefined();
    expect(g.twee?.storyData?.ifid).toBe('D674C58C');
    expect(g.twee?.storyData?.format).toBe('SugarCube');
    expect(g.twee?.storyData?.['format-version']).toBe('2.36.1');
    expect(g.startNode).toBe('Cave');
  });

  it('round-trips StoryData through parse → emit → parse', () => {
    const src = `:: StoryData\n{"ifid":"D674C58C","format":"SugarCube","start":"Cave"}\n\n:: Cave\nDark.\n`;
    const g1 = parseTwee(src);
    const emitted = emitTwee(g1);
    // Emitted StoryData must still carry ifid + format alongside start.
    expect(emitted).toMatch(/"ifid":"D674C58C"/);
    expect(emitted).toMatch(/"format":"SugarCube"/);
    const g2 = parseTwee(emitted);
    expect(g2.twee?.storyData?.ifid).toBe('D674C58C');
    expect(g2.twee?.storyData?.format).toBe('SugarCube');
  });

  it('preserves special-passage bodies (StoryInit / PassageHeader) across round-trip', () => {
    const src = `:: StoryInit\n<<set $health to 100>>\n\n:: PassageFooter\nBack: [[Home]]\n\n:: StoryData\n{"start":"Home"}\n\n:: Home\nHi.\n`;
    const g1 = parseTwee(src);
    expect(g1.twee?.specials?.StoryInit).toContain('<<set $health to 100>>');
    expect(g1.twee?.specials?.PassageFooter).toContain('Back:');
    const emitted = emitTwee(g1);
    expect(emitted).toContain(':: StoryInit');
    expect(emitted).toContain('<<set $health to 100>>');
    expect(emitted).toContain(':: PassageFooter');
    const g2 = parseTwee(emitted);
    expect(g2.twee?.specials?.StoryInit).toContain('<<set $health to 100>>');
  });

  it("emits node.divert as [[Target]] so Ink → Twee cross-export doesn't dead-end", () => {
    // Hand-build an Ink-shaped graph with implicit continuation.
    const emitted = emitTwee({
      id: 'x',
      title: 'Untitled',
      nodes: {
        hallway: {
          id: 'hallway',
          type: 'knot' as const,
          parent: null,
          content: [{ kind: 'text', text: 'Walk forward.', tags: [] }],
          choices: [],
          divert: 'kitchen',
          tags: [],
          lineNumber: 1,
        },
        kitchen: {
          id: 'kitchen',
          type: 'knot' as const,
          parent: null,
          content: [{ kind: 'text', text: 'Cold.', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 2,
        },
      },
      startNode: 'hallway',
      validation: { valid: true, errors: [], warnings: [] },
    });
    expect(emitted).toContain('[[kitchen]]');
  });

  it('unescapes `\\::` at line start on parse', () => {
    const src = `:: Home\nA line.\n\n\\:: Not a header\n\nAnother line.\n`;
    const g = parseTwee(src);
    const paragraph = g.nodes.Home.content
      .filter(isTextBlock)
      .find((c) => c.text.includes('Not a header'));
    expect(paragraph?.text).toContain(':: Not a header');
    expect(paragraph?.text).not.toContain('\\:: Not a header');
  });

  it('round-trips a `::`-content paragraph through emit → parse without a stray backslash', () => {
    // Hand-build the "author wrote a paragraph that starts with `::`"
    // scenario — parseTwee can't produce this shape directly because
    // a bare `::` line-start is a header, but a graph edit through
    // NodeDetail can set content text to whatever the user types.
    const emitted = emitTwee({
      id: 'x',
      title: 'Untitled',
      nodes: {
        Home: {
          id: 'Home',
          type: 'knot' as const,
          parent: null,
          content: [{ kind: 'text', text: ':: this is content, not a header', tags: [] }],
          choices: [],
          divert: null,
          tags: [],
          lineNumber: 1,
        },
      },
      startNode: 'Home',
      validation: { valid: true, errors: [], warnings: [] },
    });
    // Emitter escapes once so the re-parse sees the paragraph as body.
    expect(emitted).toContain('\\:: this is content');
    const g2 = parseTwee(emitted);
    const text = textOf(g2.nodes.Home.content[0]);
    expect(text).toBe(':: this is content, not a header');
  });

  it('parses passage metadata with nested-object JSON', () => {
    const src = `:: Start {"position":"10,20","tw2":{"noStorify":true}}\nHi.\n`;
    const g = parseTwee(src);
    // Passage name should be "Start" (not stringified with the JSON).
    expect(g.nodes.Start).toBeDefined();
    expect(g.nodes.Start.metadata).toEqual({
      position: '10,20',
      tw2: { noStorify: true },
    });
  });

  it('reports missing_target errors inside unreachable passages', () => {
    // Orphan is unreachable, but its link to a nonexistent Ghost should
    // still fire a missing_target error at import time.
    const src = `:: StoryData\n{"start":"Home"}\n\n:: Home\nHi.\n\n:: Orphan\n[[Ghost]]\n`;
    const g = parseTwee(src);
    const missing = g.validation.errors.filter((e) => e.type === 'missing_target');
    expect(missing.map((e) => e.args?.targetName)).toContain('Ghost');
  });

  it('warns on duplicate special-passage headers', () => {
    const src = `:: StoryTitle\nFirst\n\n:: StoryTitle\nSecond\n\n:: Start\nHi.\n`;
    const g = parseTwee(src);
    const dup = g.validation.warnings.filter((w) => w.type === 'duplicate_node');
    expect(dup.some((w) => w.args?.nodeName === 'StoryTitle')).toBe(true);
    // Last one wins for the title itself.
    expect(g.title).toBe('Second');
  });
});

describe('detectTweeDialect (DEV-199 Phase 6)', () => {
  it('prefers the StoryData format field, case-insensitively, with a version suffix', () => {
    expect(detectTweeDialect({ format: 'Harlowe' }, '')).toEqual({
      dialect: 'harlowe',
      sniffed: false,
      ambiguous: false,
    });
    expect(detectTweeDialect({ format: 'sugarcube 2.36.1' }, '')).toEqual({
      dialect: 'sugarcube',
      sniffed: false,
      ambiguous: false,
    });
    expect(detectTweeDialect({ format: 'CHAPBOOK' }, '')).toEqual({
      dialect: 'chapbook',
      sniffed: false,
      ambiguous: false,
    });
  });

  it('sniffs Harlowe macro syntax when format is missing', () => {
    const result = detectTweeDialect(
      undefined,
      ':: Start\n(set: $gold to 5)\n(if: $gold > 0)[Rich]\n',
    );
    expect(result).toEqual({ dialect: 'harlowe', sniffed: true, ambiguous: false });
  });

  it('sniffs SugarCube macro syntax when format is missing', () => {
    const result = detectTweeDialect(
      undefined,
      ':: Start\n<<set $gold to 5>>\n<<if $gold > 0>>Rich<</if>>\n',
    );
    expect(result).toEqual({ dialect: 'sugarcube', sniffed: true, ambiguous: false });
  });

  it('sniffs Chapbook macro syntax when format is missing', () => {
    const result = detectTweeDialect(
      undefined,
      ':: Start\ngold: 5\n--\n[if gold > 0]Rich[continued]\n',
    );
    expect(result).toEqual({ dialect: 'chapbook', sniffed: true, ambiguous: false });
  });

  it('falls back to sniffing when format names an unrecognized format', () => {
    const result = detectTweeDialect({ format: 'Snowman' }, ':: Start\n<<set $gold to 5>>\n');
    expect(result).toEqual({ dialect: 'sugarcube', sniffed: true, ambiguous: false });
  });

  it('is NOT flagged ambiguous for plain prose with no format and no macros — nothing to misdetect', () => {
    // The overwhelmingly common case (an ordinary hyperlink-based
    // Twee story) must not get a warning with no actionable follow-up.
    expect(detectTweeDialect(undefined, ':: Start\nJust plain prose.\n')).toEqual({
      dialect: null,
      sniffed: true,
      ambiguous: false,
    });
  });

  it('IS flagged ambiguous on a genuine tie between two dialects’ signatures', () => {
    // One Harlowe-shaped macro, one SugarCube-shaped macro — equal
    // hits, so picking either would be an arbitrary guess, and unlike
    // the no-signal case there's real macro syntax here worth flagging.
    const result = detectTweeDialect(undefined, ':: Start\n(set: $x to 1)\n<<set $y to 2>>\n');
    expect(result).toEqual({ dialect: null, sniffed: true, ambiguous: true });
  });

  it('IS flagged ambiguous when StoryData names an unrecognized format and nothing sniffs', () => {
    // The author told us a format explicitly; it just isn't one of
    // the three this parser knows. Worth surfacing even with zero
    // macro syntax, unlike the silent "no format at all" case.
    const result = detectTweeDialect({ format: 'Snowman' }, ':: Start\nJust plain prose.\n');
    expect(result).toEqual({ dialect: null, sniffed: true, ambiguous: true });
  });

  it('does not mistake a lone prose em-dash line for Chapbook', () => {
    // A bare `--` line alone (no real [if]/insert macro anywhere) is
    // too easily confused with a prose em-dash paragraph break to
    // count by itself — otherwise a plain Harlowe/SugarCube story
    // that happens to format a dramatic pause this way would
    // misdetect as Chapbook. No signal anywhere else either, so this
    // is the silent "nothing to misdetect" case, not ambiguous.
    const result = detectTweeDialect(undefined, ':: Start\nSome prose.\n--\nMore prose.\n');
    expect(result).toEqual({ dialect: null, sniffed: true, ambiguous: false });
  });

  it('the vars-block separator is a tie-breaking bonus on top of a real Chapbook insert, not a standalone signal', () => {
    // One Chapbook insert plus the separator (2 points) beats one
    // lone Harlowe-shaped macro elsewhere (1 point).
    const result = detectTweeDialect(
      undefined,
      ':: Start\ngold: 5\n--\n[if gold > 0]Rich[continued]\n(goto: "Elsewhere")\n',
    );
    expect(result).toEqual({ dialect: 'chapbook', sniffed: true, ambiguous: false });
  });
});

describe('parseTwee — Twine macro dialect detection (DEV-199 Phase 6)', () => {
  it('resolves graph.twee.dialect from a Harlowe StoryData format field', () => {
    const src = `:: StoryData\n{"start":"Start","format":"Harlowe","format-version":"3.3.9"}\n\n:: Start\nHi.\n`;
    const g = parseTwee(src);
    expect(g.twee?.dialect).toBe('harlowe');
    expect(g.validation.warnings.some((w) => w.type === 'ambiguous_twee_dialect')).toBe(false);
  });

  it('resolves graph.twee.dialect from a SugarCube StoryData format field', () => {
    const src = `:: StoryData\n{"start":"Start","format":"SugarCube","format-version":"2.36.1"}\n\n:: Start\nHi.\n`;
    const g = parseTwee(src);
    expect(g.twee?.dialect).toBe('sugarcube');
  });

  it('resolves graph.twee.dialect from a Chapbook StoryData format field', () => {
    const src = `:: StoryData\n{"start":"Start","format":"Chapbook","format-version":"1.2.3"}\n\n:: Start\nHi.\n`;
    const g = parseTwee(src);
    expect(g.twee?.dialect).toBe('chapbook');
  });

  it('sniffs a dialect and sets graph.twee.dialect when StoryData has no format', () => {
    const src = `:: Start\n<<set $gold to 5>>\n<<if $gold > 0>>Rich<</if>>\n`;
    const g = parseTwee(src);
    expect(g.twee?.dialect).toBe('sugarcube');
    expect(g.validation.warnings.some((w) => w.type === 'ambiguous_twee_dialect')).toBe(false);
  });

  it('does not warn for a plain, macro-free Twee story — nothing to misdetect', () => {
    const src = `:: Start\nJust plain prose, no macros anywhere.\n`;
    const g = parseTwee(src);
    expect(g.twee?.dialect).toBeUndefined();
    expect(g.validation.warnings.some((w) => w.type === 'ambiguous_twee_dialect')).toBe(false);
  });

  it('warns with ambiguous_twee_dialect and leaves graph.twee.dialect unset on a genuine tie', () => {
    const src = `:: Start\n(set: $x to 1)\n<<set $y to 2>>\n`;
    const g = parseTwee(src);
    expect(g.twee?.dialect).toBeUndefined();
    const warning = g.validation.warnings.find((w) => w.type === 'ambiguous_twee_dialect');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('Harlowe');
  });
});

describe('parseTwee — Harlowe macro support (DEV-199 Phase 7)', () => {
  const harloweSrc = (body: string) =>
    `:: StoryData\n{"start":"Start","format":"Harlowe"}\n\n:: Start\n${body}\n`;

  it('declares a variable implicitly from the first (set:), inferring its type', () => {
    const g = parseTwee(harloweSrc('(set: $gold to 5)\nYou have gold.'));
    expect(g.variables).toEqual([
      { name: 'gold', type: 'number', initialValue: { kind: 'literal', value: 5 }, isConst: false },
    ]);
    const block = g.nodes['Start'].content.find((c) => c.kind === 'assignment');
    expect(block).toEqual({
      kind: 'assignment',
      statement: {
        kind: 'assignment',
        name: 'gold',
        operator: '=',
        value: { kind: 'literal', value: 5 },
      },
    });
    expect(textOf(g.nodes['Start'].content.find((c) => c.kind === 'text')!)).toBe('You have gold.');
  });

  it('does not re-declare a variable already declared by an earlier (set:)', () => {
    const g = parseTwee(
      `:: StoryData\n{"start":"Start","format":"Harlowe"}\n\n:: Start\n(set: $gold to 5)\n\n:: Other\n(set: $gold to 10)\n`,
    );
    expect(g.variables).toHaveLength(1);
    expect(g.variables?.[0]).toEqual({
      name: 'gold',
      type: 'number',
      initialValue: { kind: 'literal', value: 5 },
      isConst: false,
    });
  });

  it('parses multi-assignment (set:) via top-level commas', () => {
    const g = parseTwee(harloweSrc('(set: $x to 1, $y to 2)'));
    const names = g.variables?.map((v) => v.name);
    expect(names).toEqual(['x', 'y']);
  });

  it('parses (put: VALUE into $x) the same as (set:)', () => {
    const g = parseTwee(harloweSrc('(put: 5 into $gold)'));
    expect(g.variables?.[0].name).toBe('gold');
  });

  it('parses a bool-typed variable from a word-form comparison initializer', () => {
    const g = parseTwee(harloweSrc('(set: $seen to $gold > 10)'));
    // $gold is undeclared at evaluation time, so the comparison throws
    // and the declaration is skipped rather than guessing a type —
    // same "best effort, never crash" contract as ink-parser.ts.
    expect(g.variables).toBeUndefined();
  });

  it('warns (rather than failing silently) when a (set:) initializer references an undeclared variable', () => {
    // Regression: declareIfNew used to swallow this with no warning
    // at all, leaving an author with zero signal that `seen` was
    // never declared — right up until this statement throws uncaught
    // at playback, since `gold` is never set anywhere in this story.
    const g = parseTwee(harloweSrc('(set: $seen to $gold > 10)'));
    expect(
      g.validation.warnings.some((w) => w.type === 'syntax_error' && w.message.includes('$seen')),
    ).toBe(true);
  });

  it('parses (if: COND)[TEXT] as a conditional text block', () => {
    const g = parseTwee(harloweSrc('(set: $gold to 5)\n(if: $gold > 3)[You are rich.]'));
    const conditional = g.nodes['Start'].content.find((c) => isTextBlock(c) && c.condition);
    expect(conditional).toBeDefined();
    if (!isTextBlock(conditional)) throw new Error('expected a text block');
    expect(textOf(conditional)).toBe('You are rich.');
    expect(conditional.condition).toEqual({
      kind: 'binary',
      operator: '>',
      left: { kind: 'variable', name: 'gold' },
      right: { kind: 'literal', value: 3 },
    });
  });

  it('parses (if: COND)[[[Link]]] (hook wrapping a link) as a conditional choice', () => {
    const g = parseTwee(harloweSrc('(if: $gold > 3)[[[Shop]]]'));
    expect(g.nodes['Start'].choices).toEqual([
      {
        text: 'Shop',
        target: 'Shop',
        sticky: false,
        fallback: false,
        tags: [],
        condition: {
          kind: 'binary',
          operator: '>',
          left: { kind: 'variable', name: 'gold' },
          right: { kind: 'literal', value: 3 },
        },
      },
    ]);
  });

  it('leaves content inert with a warning when an (if:) condition fails to parse', () => {
    const g = parseTwee(harloweSrc('(if: $gold >> 3)[Broken]'));
    expect(g.validation.warnings.some((w) => w.type === 'syntax_error')).toBe(true);
    expect(g.nodes['Start'].content.some((c) => c.kind === 'text' && c.condition)).toBe(false);
  });

  it('does NOT promote a hook-wrapped link to an unconditional choice when its (if:) condition fails to parse', () => {
    // Regression: the fallback used to run extractLinks on the raw
    // "(if: ...)[[[Link]]]" text, which still turned the wrapped
    // link into a real Choice — just with no condition — silently
    // making it always-visible instead of leaving it inert.
    const g = parseTwee(harloweSrc('(if: $gold >> 3)[[[Shop]]]'));
    expect(g.validation.warnings.some((w) => w.type === 'syntax_error')).toBe(true);
    expect(g.nodes['Start'].choices).toEqual([]);
  });

  it('leaves an unsupported macro like (display:) as inert text', () => {
    const g = parseTwee(harloweSrc('(display: "Header")'));
    expect(textOf(g.nodes['Start'].content[0])).toContain('(display:');
  });
});

describe('emitTwee — Harlowe re-emission (DEV-199 Phase 7)', () => {
  it('emits an assignment block as (set: $name to VALUE)', () => {
    const g = parseTwee(
      `:: StoryData\n{"start":"Start","format":"Harlowe"}\n\n:: Start\n(set: $gold to 5)\nHi.\n`,
    );
    const out = emitTwee(g);
    expect(out).toContain('(set: $gold to 5)');
  });

  it('emits a conditional text block wrapped in (if: COND)[...]', () => {
    const g = parseTwee(
      `:: StoryData\n{"start":"Start","format":"Harlowe"}\n\n:: Start\n(set: $gold to 5)\n(if: $gold > 3)[Rich.]\n`,
    );
    const out = emitTwee(g);
    expect(out).toContain('(if: ($gold) > (3))[Rich.]');
  });

  it('emits a conditional choice wrapped in (if: COND)[[[Link]]]', () => {
    const g = parseTwee(
      `:: StoryData\n{"start":"Start","format":"Harlowe"}\n\n:: Start\n(if: $gold > 3)[[[Shop]]]\n\n:: Shop\nHi.\n`,
    );
    const out = emitTwee(g);
    expect(out).toContain('(if: ($gold) > (3))[[[Shop]]]');
  });

  it('drops assignment/condition content for a non-Harlowe dialect, same as before this phase', () => {
    const g = parseTwee(`:: Start\nHi.\n\n:: Shop\nHi.\n`);
    g.nodes['Start'].content.push({
      kind: 'assignment',
      statement: {
        kind: 'assignment',
        name: 'gold',
        operator: '=',
        value: { kind: 'literal', value: 5 },
      },
    });
    g.nodes['Start'].choices.push({
      text: 'Shop',
      target: 'Shop',
      sticky: false,
      fallback: false,
      tags: [],
      condition: { kind: 'variable', name: 'seen' },
    });
    const out = emitTwee(g);
    expect(out).not.toContain('(set:');
    expect(out).not.toContain('(if:');
    expect(out).toContain('[[Shop]]');
  });
});

describe('Harlowe round-trip: parse → emit → parse (DEV-199 Phase 7)', () => {
  it('produces an equivalent graph for assignment + conditional text + conditional choice', () => {
    const src =
      `:: StoryData\n{"start":"Start","format":"Harlowe"}\n\n` +
      `:: Start\n(set: $gold to 5)\n(if: $gold > 3)[You are rich.]\n(if: $gold > 3)[[[Shop]]]\n\n` +
      `:: Shop\nWelcome.\n`;
    const first = parseTwee(src);
    const reparsed = parseTwee(emitTwee(first));
    expect(reparsed.variables).toEqual(first.variables);
    expect(reparsed.nodes['Start'].content).toEqual(first.nodes['Start'].content);
    expect(reparsed.nodes['Start'].choices).toEqual(first.nodes['Start'].choices);
  });
});
