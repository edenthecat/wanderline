import {
  collectDeletionSet,
  findInboundReferences,
  insertNodeOrdered,
  parseNewNodeId,
  repointReferences,
  resolveTargetId,
  MAX_NODE_ID_LENGTH,
  type GraphNodes,
} from '../story-node-ops.js';

// Pure-function counterpart to story-node-crud.test.ts: the route test
// covers the transaction, these cover the graph reasoning it depends on
// (which references count, which nodes go with a knot, where a new one
// lands in the fall-through order).

function inkGraph(): GraphNodes {
  return {
    intro: { id: 'intro', type: 'knot', parent: null, choices: [], divert: 'ch1', lineNumber: 1 },
    ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 5 },
    'ch1.a': {
      id: 'ch1.a',
      type: 'stitch',
      parent: 'ch1',
      choices: [{ target: 'b' }],
      divert: null,
      lineNumber: 7,
    },
    'ch1.b': {
      id: 'ch1.b',
      type: 'stitch',
      parent: 'ch1',
      choices: [],
      divert: null,
      lineNumber: 9,
    },
  };
}

describe('resolveTargetId', () => {
  it('resolves an exact key, a terminal target and an unknown name', () => {
    const nodes = inkGraph();
    expect(resolveTargetId('ch1', 'intro', nodes, 'ink')).toBe('ch1');
    expect(resolveTargetId('END', 'intro', nodes, 'ink')).toBeNull();
    expect(resolveTargetId('DONE', 'intro', nodes, 'ink')).toBeNull();
    expect(resolveTargetId('nowhere', 'intro', nodes, 'ink')).toBeNull();
    expect(resolveTargetId(null, 'intro', nodes, 'ink')).toBeNull();
  });

  it('scopes a bare Ink name to the referring knot', () => {
    const nodes = inkGraph();
    expect(resolveTargetId('b', 'ch1.a', nodes, 'ink')).toBe('ch1.b');
    expect(resolveTargetId('b', 'ch1', nodes, 'ink')).toBe('ch1.b');
    // A bare name written in a DIFFERENT knot scopes to that knot, so
    // it does not reach ch1's stitch.
    expect(resolveTargetId('b', 'intro', nodes, 'ink')).toBeNull();
  });

  it('never applies Ink scoping to a Twee graph', () => {
    // A Twee passage may legally be called `ch1.b`, and a link written
    // as `b` means the passage `b` — not `ch1.b`.
    const nodes: GraphNodes = {
      ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      'ch1.b': {
        id: 'ch1.b',
        type: 'knot',
        parent: null,
        choices: [],
        divert: null,
        lineNumber: 2,
      },
    };
    expect(resolveTargetId('b', 'ch1', nodes, 'twee')).toBeNull();
    expect(resolveTargetId('ch1.b', 'ch1', nodes, 'twee')).toBe('ch1.b');
  });

  it('does not treat inherited Object properties as nodes', () => {
    // `toString` is a legal Ink name under the parser's \w+ rule, and a
    // plain object answers truthily for it.
    const nodes = inkGraph();
    expect(resolveTargetId('toString', 'intro', nodes, 'ink')).toBeNull();
  });
});

describe('collectDeletionSet', () => {
  it('takes an Ink knot with its stitches', () => {
    const nodes = inkGraph();
    expect(collectDeletionSet('ch1', nodes, 'ink').sort()).toEqual(['ch1', 'ch1.a', 'ch1.b']);
  });

  it('takes only the stitch when a stitch is deleted', () => {
    expect(collectDeletionSet('ch1.a', inkGraph(), 'ink')).toEqual(['ch1.a']);
  });

  it('catches a stitch keyed under the knot even when parent is stale', () => {
    const nodes = inkGraph();
    nodes['ch1.b'].parent = null;
    expect(collectDeletionSet('ch1', nodes, 'ink').sort()).toEqual(['ch1', 'ch1.a', 'ch1.b']);
  });

  it('never cascades in a Twee graph, where a dot is just a character', () => {
    const nodes: GraphNodes = {
      ch1: { id: 'ch1', type: 'knot', parent: null, choices: [], divert: null, lineNumber: 1 },
      'ch1.b': {
        id: 'ch1.b',
        type: 'knot',
        parent: null,
        choices: [],
        divert: null,
        lineNumber: 2,
      },
    };
    expect(collectDeletionSet('ch1', nodes, 'twee')).toEqual(['ch1']);
  });
});

describe('findInboundReferences', () => {
  it('finds choices and diverts, including bare Ink stitch names', () => {
    const nodes = inkGraph();
    const refs = findInboundReferences(new Set(['ch1.b']), nodes, 'ink');
    expect(refs).toEqual([
      { from: 'ch1.a', via: 'choice', choiceIndex: 0, target: 'b', resolved: 'ch1.b' },
    ]);

    const knotRefs = findInboundReferences(new Set(['ch1', 'ch1.a', 'ch1.b']), nodes, 'ink');
    // intro -> ch1 by divert; ch1.a -> ch1.b is INSIDE the set and so
    // is not a blocker.
    expect(knotRefs).toEqual([{ from: 'intro', via: 'divert', target: 'ch1', resolved: 'ch1' }]);
  });

  it('ignores references that come from inside the delete set', () => {
    const nodes = inkGraph();
    expect(findInboundReferences(new Set(['ch1.a', 'ch1.b']), nodes, 'ink')).toEqual([]);
  });
});

describe('repointReferences', () => {
  it('rewrites choice targets and diverts in place', () => {
    const nodes = inkGraph();
    const refs = findInboundReferences(new Set(['ch1', 'ch1.a', 'ch1.b']), nodes, 'ink');
    repointReferences(refs, 'END', nodes);
    expect(nodes.intro.divert).toBe('END');

    const stitchRefs = findInboundReferences(new Set(['ch1.b']), nodes, 'ink');
    repointReferences(stitchRefs, 'intro', nodes);
    // Rewritten to the FULL key, never a bare name — a bare name would
    // re-resolve against whichever knot happened to hold it.
    expect(nodes['ch1.a'].choices?.[0].target).toBe('intro');
  });
});

describe('parseNewNodeId', () => {
  it('classifies Ink knots and stitches', () => {
    expect(parseNewNodeId('chapter', 'ink')).toEqual({
      nodeId: 'chapter',
      type: 'knot',
      parent: null,
    });
    expect(parseNewNodeId('  chapter.scene  ', 'ink')).toEqual({
      nodeId: 'chapter.scene',
      type: 'stitch',
      parent: 'chapter',
    });
  });

  it('rejects Ink names the emitter would rewrite or the parser would reject', () => {
    // Leading digit: the emitter prefixes `_`, so the round-trip would
    // produce a different node.
    expect(parseNewNodeId('1scene', 'ink')).toHaveProperty('error');
    expect(parseNewNodeId('the kitchen', 'ink')).toHaveProperty('error');
    expect(parseNewNodeId('a.b.c', 'ink')).toHaveProperty('error');
    expect(parseNewNodeId('', 'ink')).toHaveProperty('error');
    expect(parseNewNodeId('   ', 'ink')).toHaveProperty('error');
    expect(parseNewNodeId('END', 'ink')).toHaveProperty('error');
    expect(parseNewNodeId('DONE', 'twee')).toHaveProperty('error');
  });

  it('rejects ids too long for the side tables node_id column', () => {
    const long = 'a'.repeat(MAX_NODE_ID_LENGTH + 1);
    expect(parseNewNodeId(long, 'twee')).toHaveProperty('error');
    expect(parseNewNodeId('a'.repeat(MAX_NODE_ID_LENGTH), 'twee')).not.toHaveProperty('error');
  });

  it('rejects control characters', () => {
    expect(parseNewNodeId('a\u0001b', 'twee')).toHaveProperty('error');
  });

  it('accepts free-form Twee names but not link delimiters or specials', () => {
    expect(parseNewNodeId('The Kitchen', 'twee')).toEqual({
      nodeId: 'The Kitchen',
      type: 'knot',
      parent: null,
    });
    // A dot is an ordinary character in a Twee title — never a path.
    expect(parseNewNodeId('Ch1.Scene', 'twee')).toEqual({
      nodeId: 'Ch1.Scene',
      type: 'knot',
      parent: null,
    });
    expect(parseNewNodeId('A|B', 'twee')).toHaveProperty('error');
    expect(parseNewNodeId('A->B', 'twee')).toHaveProperty('error');
    expect(parseNewNodeId('[A]', 'twee')).toHaveProperty('error');
    expect(parseNewNodeId('StoryData', 'twee')).toHaveProperty('error');
  });
});

describe('insertNodeOrdered', () => {
  const orderOf = (nodes: GraphNodes) =>
    Object.keys(nodes).sort((a, b) => (nodes[a].lineNumber ?? 0) - (nodes[b].lineNumber ?? 0));

  it('appends a knot after every existing node', () => {
    const nodes = inkGraph();
    insertNodeOrdered(
      nodes,
      'ch2',
      { id: 'ch2', type: 'knot', parent: null },
      {
        parent: null,
        sourceLanguage: 'ink',
      },
    );
    expect(orderOf(nodes)).toEqual(['intro', 'ch1', 'ch1.a', 'ch1.b', 'ch2']);
  });

  it('places a knot after the anchor knot AND its stitches', () => {
    const nodes = inkGraph();
    insertNodeOrdered(
      nodes,
      'ch2',
      { id: 'ch2', type: 'knot', parent: null },
      { afterId: 'ch1', parent: null, sourceLanguage: 'ink' },
    );
    // Not between `ch1` and its own first stitch.
    expect(orderOf(nodes)).toEqual(['intro', 'ch1', 'ch1.a', 'ch1.b', 'ch2']);

    const nodes2 = inkGraph();
    insertNodeOrdered(
      nodes2,
      'ch0',
      { id: 'ch0', type: 'knot', parent: null },
      { afterId: 'intro', parent: null, sourceLanguage: 'ink' },
    );
    expect(orderOf(nodes2)).toEqual(['intro', 'ch0', 'ch1', 'ch1.a', 'ch1.b']);
  });

  it('inserts a stitch between siblings, which is what fall-through reads', () => {
    const nodes = inkGraph();
    insertNodeOrdered(
      nodes,
      'ch1.mid',
      { id: 'ch1.mid', type: 'stitch', parent: 'ch1' },
      { afterId: 'ch1.a', parent: 'ch1', sourceLanguage: 'ink' },
    );
    expect(orderOf(nodes)).toEqual(['intro', 'ch1', 'ch1.a', 'ch1.mid', 'ch1.b']);
  });

  it('appends a stitch to the end of its own knot, not the end of the story', () => {
    const nodes = inkGraph();
    nodes.ch2 = { id: 'ch2', type: 'knot', parent: null, lineNumber: 20 };
    insertNodeOrdered(
      nodes,
      'ch1.c',
      { id: 'ch1.c', type: 'stitch', parent: 'ch1' },
      { parent: 'ch1', sourceLanguage: 'ink' },
    );
    expect(orderOf(nodes)).toEqual(['intro', 'ch1', 'ch1.a', 'ch1.b', 'ch1.c', 'ch2']);
  });

  it('places exactly in a graph where every lineNumber is 0', () => {
    // What a compiled-Ink-JSON upload produces: no ordering information
    // at all beyond key order. Renumbering is what makes "after X"
    // mean anything here.
    const nodes: GraphNodes = {
      a: { id: 'a', type: 'knot', parent: null, lineNumber: 0 },
      b: { id: 'b', type: 'knot', parent: null, lineNumber: 0 },
      c: { id: 'c', type: 'knot', parent: null, lineNumber: 0 },
    };
    insertNodeOrdered(
      nodes,
      'inserted',
      { id: 'inserted', type: 'knot', parent: null },
      { afterId: 'a', parent: null, sourceLanguage: 'ink' },
    );
    expect(orderOf(nodes)).toEqual(['a', 'inserted', 'b', 'c']);
    expect(Object.values(nodes).map((n) => n.lineNumber)).toEqual([1, 3, 4, 2]);
  });

  it('preserves the existing order of everything it did not insert', () => {
    const nodes = inkGraph();
    const before = orderOf(nodes);
    insertNodeOrdered(
      nodes,
      'ch1.mid',
      { id: 'ch1.mid', type: 'stitch', parent: 'ch1' },
      { afterId: 'ch1.a', parent: 'ch1', sourceLanguage: 'ink' },
    );
    expect(orderOf(nodes).filter((id) => id !== 'ch1.mid')).toEqual(before);
  });
});
