// Y.Doc <-> story_graph JSON converter.
//
// The collab Y.Doc holds the canonical story shape:
//   doc.getMap('nodes'): Y.Map<NodeId, Y.Map>
//     each node's map holds:
//       'type'    -> string                  (knot / stitch / gather)
//       'parent'  -> string | null
//       'divert'  -> string | null
//       'lineNumber' -> number
//       'tags'    -> Y.Array<string>
//       'content' -> Y.Array<{ text: Y.Text, tags: Y.Array<string> }>
//       'choices' -> Y.Array<{ text: Y.Text, target: string, sticky: bool,
//                              fallback: bool, tags: Y.Array<string> }>
//
// `text` payloads are Y.Text so concurrent character-level edits
// merge correctly. Structural fields (target, type, parent, etc.)
// are plain scalars in the Y.Map — last-writer-wins is fine for
// those.
//
// Both directions live here so the round-trip is testable in one
// place. Hydration: when a project's collab room is created and
// has no doc state yet, the server reads project_stories.story_graph
// JSON, seeds the Y.Doc, and then live edits flow through Yjs.
// Materialization: a debounced "shadow saver" reads Y.Doc → JSON
// and PATCHes the row so non-collab consumers (build pipeline,
// preview, validation) stay current.

import * as Y from 'yjs';
import type {
  StoryGraph,
  StoryNode,
  Choice,
  ContentBlock,
  Expression,
  Statement,
} from '../types.js';

const NODES_KEY = 'nodes';

interface SerializableNode {
  type: StoryNode['type'];
  parent: StoryNode['parent'];
  divert: StoryNode['divert'];
  lineNumber: number;
  tags: string[];
  content: ContentBlock[];
  choices: Choice[];
  audio?: StoryNode['audio'];
}

/**
 * Expressions/statements (DEV-199) are edited as a single atomic
 * value, not character-by-character like narration text, so a JSON
 * string under a plain Y.Map key — last-writer-wins, same as every
 * other structural field here — is the right fit. No Y.Text needed.
 */
function buildContentItem(item: ContentBlock): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('kind', item.kind);
  if (item.kind === 'assignment') {
    m.set('statement', JSON.stringify(item.statement));
    return m;
  }
  const yText = new Y.Text();
  yText.insert(0, item.text);
  m.set('text', yText);
  const tags = new Y.Array<string>();
  tags.push(item.tags ?? []);
  m.set('tags', tags);
  if (item.condition) {
    m.set('condition', JSON.stringify(item.condition));
  }
  return m;
}

function buildChoiceItem(ch: Choice): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  const yText = new Y.Text();
  yText.insert(0, ch.text);
  m.set('text', yText);
  m.set('target', ch.target);
  m.set('sticky', ch.sticky);
  m.set('fallback', ch.fallback);
  const tags = new Y.Array<string>();
  tags.push(ch.tags ?? []);
  m.set('tags', tags);
  if (ch.condition) {
    m.set('condition', JSON.stringify(ch.condition));
  }
  return m;
}

/**
 * Populate an empty Y.Doc from a story_graph JSON snapshot. Idempotent:
 * if `nodes` map is already populated, this is a no-op (skip-seed
 * semantics so two simultaneous hydrators don't double up).
 */
export function seedYDocFromStoryGraph(doc: Y.Doc, storyGraph: StoryGraph): void {
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  if (nodesMap.size > 0) return;
  doc.transact(() => {
    for (const [id, n] of Object.entries(storyGraph.nodes)) {
      const nodeMap = new Y.Map<unknown>();
      nodeMap.set('type', n.type);
      nodeMap.set('parent', n.parent);
      nodeMap.set('divert', n.divert);
      nodeMap.set('lineNumber', n.lineNumber);
      const tags = new Y.Array<string>();
      tags.push(n.tags ?? []);
      nodeMap.set('tags', tags);
      const content = new Y.Array<Y.Map<unknown>>();
      content.push((n.content ?? []).map(buildContentItem));
      nodeMap.set('content', content);
      const choices = new Y.Array<Y.Map<unknown>>();
      choices.push((n.choices ?? []).map(buildChoiceItem));
      nodeMap.set('choices', choices);
      if (n.audio) {
        // Audio assignments are id-references; last-writer-wins on
        // the same slot is fine, so a plain Y.Map of scalars works.
        const audio = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(n.audio)) audio.set(k, v);
        nodeMap.set('audio', audio);
      }
      nodesMap.set(id, nodeMap);
    }
  }, 'seed');
}

function readArrayOfStrings(arr: Y.Array<string> | undefined): string[] {
  if (!arr) return [];
  return arr.toArray();
}

/** Parses a JSON-string-encoded AST value, tolerating old rows that
 * never had the key at all (returns undefined) rather than throwing. */
function readJsonField<T>(m: Y.Map<unknown>, key: string): T | undefined {
  const raw = m.get(key);
  if (typeof raw !== 'string') return undefined;
  return JSON.parse(raw) as T;
}

function readContentItem(m: Y.Map<unknown>): ContentBlock {
  // `kind` is required on ContentBlock, but a pre-DEV-199 row never
  // wrote one — treat anything other than an explicit 'assignment' as
  // text, matching isTextBlock's own contract in types.ts.
  if (m.get('kind') === 'assignment') {
    const statement = readJsonField<Statement>(m, 'statement');
    if (!statement) {
      throw new Error("Yjs content item has kind='assignment' but no parseable statement");
    }
    return { kind: 'assignment', statement };
  }
  const text = m.get('text');
  const textStr = text instanceof Y.Text ? text.toString() : String(text ?? '');
  const condition = readJsonField<Expression>(m, 'condition');
  return {
    kind: 'text',
    text: textStr,
    tags: readArrayOfStrings(m.get('tags') as Y.Array<string> | undefined),
    ...(condition !== undefined ? { condition } : {}),
  };
}

function readChoiceItem(m: Y.Map<unknown>): Choice {
  const text = m.get('text');
  const textStr = text instanceof Y.Text ? text.toString() : String(text ?? '');
  const condition = readJsonField<Expression>(m, 'condition');
  return {
    text: textStr,
    target: String(m.get('target') ?? ''),
    sticky: Boolean(m.get('sticky')),
    fallback: Boolean(m.get('fallback')),
    tags: readArrayOfStrings(m.get('tags') as Y.Array<string> | undefined),
    ...(condition !== undefined ? { condition } : {}),
  };
}

function readNode(id: string, m: Y.Map<unknown>): StoryNode {
  const node: SerializableNode = {
    type: (m.get('type') as StoryNode['type']) ?? 'knot',
    parent: (m.get('parent') as string | null) ?? null,
    divert: (m.get('divert') as string | null) ?? null,
    lineNumber: Number(m.get('lineNumber') ?? 0),
    tags: readArrayOfStrings(m.get('tags') as Y.Array<string> | undefined),
    content: ((m.get('content') as Y.Array<Y.Map<unknown>> | undefined)?.toArray() ?? []).map(
      readContentItem,
    ),
    choices: ((m.get('choices') as Y.Array<Y.Map<unknown>> | undefined)?.toArray() ?? []).map(
      readChoiceItem,
    ),
  };
  if (m.has('audio')) {
    const audioMap = m.get('audio') as Y.Map<unknown>;
    const audio: Record<string, unknown> = {};
    audioMap.forEach((v, k) => {
      audio[k] = v;
    });
    node.audio = audio as StoryNode['audio'];
  }
  return { id, ...node };
}

/**
 * Read the current Y.Doc state into a plain StoryGraph JSON. Used
 * by the shadow saver to PATCH project_stories on a debounce, and
 * by tests to assert round-trip fidelity.
 *
 * The non-node parts of StoryGraph (id, title, startNode, validation,
 * source) aren't owned by the Y.Doc — they're project-level
 * metadata that doesn't collaborate. The caller is expected to
 * merge in the previous values for those fields.
 */
export function materializeNodesFromYDoc(doc: Y.Doc): Record<string, StoryNode> {
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const out: Record<string, StoryNode> = {};
  nodesMap.forEach((nodeMap, id) => {
    out[id] = readNode(id, nodeMap);
  });
  return out;
}
