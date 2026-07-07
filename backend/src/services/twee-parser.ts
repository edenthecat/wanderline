/**
 * Twee 3 parser.
 *
 * Parses a Twee 3 source string into a StoryGraph, the same shape the
 * Ink parser produces so downstream (validation, editing, preview,
 * build) treat both formats interchangeably.
 *
 * Supported subset (v1):
 *   - `:: PassageName` headers, with optional `[tag1 tag2]` and
 *     `{"position":"x,y"}` JSON metadata.
 *   - Link syntax, all four shapes:
 *       [[Target]]
 *       [[Text|Target]]
 *       [[Text->Target]]
 *       [[Target<-Text]]
 *   - Special passages: StoryTitle (→ graph.title), StoryData (JSON,
 *     preserved in full on graph.twee.storyData with `start` seeding
 *     the entry passage), Start (fallback start), and the wrapper
 *     passages StoryInit / PassageHeader / PassageFooter /
 *     StoryCaption / StoryMenu / StoryAuthor / StorySubtitle
 *     (bodies preserved verbatim on graph.twee.specials so a
 *     graph edit + re-emit doesn't destroy them).
 *
 * Deliberately out of scope for v1 (surface as follow-ups):
 *   - <<macros>> — parsed but preserved verbatim in content text.
 *   - Conditional links (`[[Text|Target][cond]]`) — parsed as if the
 *     condition wasn't there.
 *
 * Twee 1 rejection: the `.tw` extension is used for both Twee 1 and
 * Twee 3. Detection is a single signal — a source with NO `:: `
 * header and at least one `!Name` line at column 0. We throw a
 * TweeParseError with code `'twee1_detected'` and a message asking
 * the user to re-export from Twine 2 as Twee 3.
 */

import { randomUUID } from 'node:crypto';
import type {
  StoryGraph,
  StoryNode,
  TextContent,
  Choice,
  ValidationResult,
  ValidationMessage,
  NodeType,
} from '../types.js';

export class TweeParseError extends Error {
  constructor(
    message: string,
    public code: 'twee1_detected' | 'no_passages' | 'duplicate_passage' | 'unsafe_passage_name',
  ) {
    super(message);
    this.name = 'TweeParseError';
  }
}

interface PassageHeader {
  name: string;
  tags: string[];
  /** Twee 3 header metadata — position/size from Twine's grid layout,
   * plus arbitrary editor annotations. Copied onto StoryNode.metadata
   * so emitTwee can reproduce it on export. */
  metadata: Record<string, unknown> | null;
  /** 1-based line number the `::` header sat on. */
  lineNumber: number;
}

interface RawPassage {
  header: PassageHeader;
  body: string;
}

/**
 * Split the source into raw `:: header` blocks. Each returned entry
 * has its header parsed and its body captured verbatim (leading /
 * trailing newlines trimmed to keep the emit-round-trip stable).
 */
function splitPassages(source: string): RawPassage[] {
  const lines = source.split('\n');
  const passages: RawPassage[] = [];
  let currentHeader: PassageHeader | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentHeader) {
      passages.push({
        header: currentHeader,
        body: currentBody.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Twee 3 headers must be at line-start with `:: `. `\:` at the
    // start of a line is an escaped literal — treat as content.
    if (raw.startsWith(':: ') || raw === '::') {
      flush();
      currentHeader = parsePassageHeader(raw, i + 1);
      currentBody = [];
    } else {
      currentBody.push(raw);
    }
  }
  flush();
  return passages;
}

/**
 * Parse a `:: Name [tag1 tag2] {"position":"x,y"}` line.
 *
 * The name spans from after `::` up to the first `[` or `{`. Tags are
 * whitespace-separated inside `[]`; metadata is the JSON object in
 * `{}`. Either can be absent. If either fails to parse, we skip it
 * with a null so the passage still lands as content — the goal is
 * "import doesn't crash on a weird header", not "reject the whole
 * story".
 */
/**
 * return the trailing `{...}` group of `rest` treating braces
 * as balanced. Ignores braces inside JSON strings so a `":": "{}"`
 * value doesn't confuse the scan. Returns `null` when the string
 * doesn't end in a closing brace or the braces don't balance.
 */
function extractTrailingBraceGroup(rest: string): { start: number; text: string } | null {
  const trimmed = rest.trimEnd();
  if (!trimmed.endsWith('}')) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) {
        // Position `i` is the opening brace. Consumed trailing
        // whitespace via trimEnd, so shift the start back by the
        // difference to keep the caller's slice offset accurate.
        const leadingSpaces = rest.slice(0, i).match(/\s+$/);
        const startInRest = i - (leadingSpaces ? leadingSpaces[0].length : 0);
        return { start: startInRest, text: trimmed.slice(i) };
      }
    }
  }
  return null;
}

function parsePassageHeader(rawLine: string, lineNumber: number): PassageHeader {
  // Strip the leading `:: ` (or `::` with no space for a passage
  // literally named the empty string — treat as unnamed).
  let rest = rawLine.slice(rawLine.startsWith(':: ') ? 3 : 2);

  let tags: string[] = [];
  let metadata: Record<string, unknown> | null = null;

  // brace-balanced metadata scan. `{[^{}]*}` rejects any
  // nested object (Tweego / newer Twine emit `{"tw2":{"noStorify":true}}`
  // shapes), which would leave the whole `{...}` inside the passage
  // name and every `[[Start]]` link fail to resolve. Walk from the
  // end of the string, matching braces, and pull the JSON slice.
  const metaSlice = extractTrailingBraceGroup(rest);
  if (metaSlice) {
    try {
      const parsed = JSON.parse(metaSlice.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore — metadata is decorative in v1. Falling through with
      // `rest` truncated matches the historical shape.
    }
    rest = rest.slice(0, metaSlice.start).trimEnd();
  }

  // Optional `[tag1 tag2]` tag list.
  const tagsMatch = /\s*\[([^\]]*)\]\s*$/.exec(rest);
  if (tagsMatch) {
    tags = tagsMatch[1]
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    rest = rest.slice(0, tagsMatch.index);
  }

  return {
    name: rest.trim(),
    tags,
    metadata,
    lineNumber,
  };
}

/**
 * Twee 1 detection heuristics. False positives here just fail the
 * import with a helpful error, so we err on the side of specificity
 * — one signal, not aggregated fuzzy matches.
 */
function detectTwee1(source: string): boolean {
  // A `::` header is Twee 3's defining marker. `splitPassages` accepts
  // both `:: <name>` and a bare `::` line (empty-name header), so we
  // match the same shape here — otherwise a source consisting only
  // of empty-name headers would misclassify as Twee 1 and get
  // rejected. Twee 1 used `!Passage` at column 0.
  if (/^::(?:\s|$)/m.test(source)) return false;
  // No Twee 3 header + line starting with `!`? Almost certainly Twee 1.
  if (/^![A-Za-z]/m.test(source)) return true;
  return false;
}

// Passage names that are metadata, not story nodes.
const SPECIAL_PASSAGES = new Set([
  'StoryTitle',
  'StoryData',
  'StoryInit',
  'PassageHeader',
  'PassageFooter',
  'StoryCaption',
  'StoryMenu',
  'StoryAuthor',
  'StorySubtitle',
]);

/**
 * extract every link on a passage body + return the body
 * text with the links removed (so the plain content lines don't
 * contain markup). Handles all four shapes documented in the file
 * header.
 *
 * A conditional `[Cond]` suffix (Twine's SugarCube macro pattern) is
 * tolerated but stripped — the parser doesn't evaluate conditions.
 */
function extractLinks(body: string): { choices: Choice[]; contentBody: string } {
  const choices: Choice[] = [];
  const linkPattern = /\[\[([^\][]*?)\]\](?:\[[^\]]*\])?/g;
  const contentBody = body.replace(linkPattern, (_full, inner: string) => {
    const link = parseLinkInner(inner);
    if (link) choices.push(link);
    // Links are removed from the content stream — they're modelled
    // as choices, not inline text.
    return '';
  });
  return { choices, contentBody };
}

function parseLinkInner(inner: string): Choice | null {
  const trimmed = inner.trim();
  if (!trimmed) return null;
  let text: string;
  let target: string;
  // Split on the FIRST occurrence of the delimiter — `String.split`
  // returns every segment, so `'a->b->c'.split('->')` yields three
  // parts and destructuring silently drops `->c`. Use indexOf so a
  // delimiter appearing later in the text/target survives.
  //
  // Delimiter priority when multiple are present in the same link:
  // `|` beats `->`/`<-`. A link like `[[Attack -> retreat|Cave]]`
  // is authored as pipe form (text on the left, target on the right)
  // — splitting at `->` first would produce text='Attack' and
  // target='retreat|Cave' which is neither what the author wrote nor
  // a resolvable passage. Arrow-form links exist too but they never
  // legitimately contain a `|` in the text or target (Twee 3 spec).
  let idx: number;
  if ((idx = trimmed.indexOf('|')) !== -1) {
    // Shape: [[Text|Target]]
    text = trimmed.slice(0, idx).trim();
    target = trimmed.slice(idx + 1).trim();
  } else if ((idx = trimmed.indexOf('->')) !== -1) {
    // Shape: [[Text->Target]]
    text = trimmed.slice(0, idx).trim();
    target = trimmed.slice(idx + 2).trim();
  } else if ((idx = trimmed.indexOf('<-')) !== -1) {
    // Shape: [[Target<-Text]] (reversed)
    target = trimmed.slice(0, idx).trim();
    text = trimmed.slice(idx + 2).trim();
  } else {
    // Shape: [[Target]] — display text is the target name.
    text = trimmed;
    target = trimmed;
  }
  if (!target) return null;
  return {
    text: text || target,
    target,
    sticky: false,
    fallback: false,
    tags: [],
  };
}

/**
 * Twee 3 identifiers can contain spaces, but StoryGraph node
 * ids are keyed under Record<string, StoryNode>. We use the passage
 * name verbatim as the id — same convention Ink uses for knot names —
 * so `[[go home]]` in Twee resolves to the passage `Home` (or `go home`
 * if that's the actual passage title). No normalisation.
 */
function passageNameToId(name: string): string {
  return name;
}

/**
 * Parse the raw body content into a TextContent[]. Twee stores prose
 * as a single flat block; we split on blank lines to give each paragraph
 * its own TextContent (parity with Ink's stitch-per-paragraph feel).
 */
function bodyToContent(body: string): TextContent[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map(
      (text): TextContent => ({
        // reverse the `\::` line-start escape the emitter
        // writes. Without this, a genuine `::` paragraph starts
        // gets a permanent leading backslash on every round-trip.
        // Only strips the ONE backslash that guards the delimiter;
        // authors who want a literal `\::` at line-start can
        // double-escape as `\\::` (and that only affects them if
        // they later mutate the graph, which is a fine trade).
        text: text.replace(/(^|\n)\\::/g, '$1::'),
        tags: [],
      }),
    );
}

export interface ParseTweeOptions {
  /** Story ID to assign. Generated when omitted. */
  storyId?: string;
}

/**
 * Parse a Twee 3 source string into a StoryGraph.
 *
 * Throws `TweeParseError` on:
 *   - `twee1_detected` — the source looks like Twee 1; user should re-export.
 *   - `no_passages` — the source has no `::` headers at all.
 *   - `duplicate_passage` — two passages share a name (would collide on the id).
 *
 * Everything else surfaces as a validation warning/error inside the
 * returned graph so the import survives and shows the user what
 * needs fixing (missing link targets, orphaned passages, etc.).
 */
export function parseTwee(source: string, options: ParseTweeOptions = {}): StoryGraph {
  if (detectTwee1(source)) {
    throw new TweeParseError(
      'This looks like Twee 1. Twee 1 support is planned; please re-export as Twee 3 from your Twine build for now.',
      'twee1_detected',
    );
  }

  const rawPassages = splitPassages(source);
  if (rawPassages.length === 0) {
    throw new TweeParseError(
      'No passages found. A Twee 3 file must contain at least one `:: Name` header.',
      'no_passages',
    );
  }

  // Null-prototype object so passage names like `constructor` /
  // `toString` / `__proto__` don't collide with Object.prototype
  // and can't be used to smuggle a prototype-pollution key past the
  // duplicate check. Object.hasOwn(nodes, id) below is the paired
  // safe lookup.
  const nodes: Record<string, StoryNode> = Object.create(null);
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  let title = '';
  let startPassage: string | null = null;
  let fallbackStart: string | null = null;
  // retain every StoryData field beyond `start` so the
  // Twee → graph → Twee round-trip doesn't lose ifid / format /
  // format-version / tag-colors / zoom.
  let storyData: Record<string, unknown> | undefined;
  // retain special-passage bodies (StoryInit / PassageHeader /
  // PassageFooter / etc) so re-emit reproduces them.
  const specials: Record<string, string> = Object.create(null);
  const seenSpecials = new Set<string>();

  for (const raw of rawPassages) {
    if (SPECIAL_PASSAGES.has(raw.header.name)) {
      // warn on duplicate special-passage headers instead of
      // silently keeping the last one. The dispatch used to run
      // before the duplicate-passage check, so a hand-edited Twee
      // with two `:: StoryData` blocks lost the earlier value
      // without any diagnostic.
      if (seenSpecials.has(raw.header.name)) {
        warnings.push({
          type: 'duplicate_node',
          message: `Duplicate "${raw.header.name}" passage — only the last one takes effect.`,
          nodeId: raw.header.name,
          args: { nodeName: raw.header.name, nodeKind: 'special' },
        });
      }
      seenSpecials.add(raw.header.name);
      handleSpecialPassage(raw, {
        setTitle: (t) => (title = t),
        setStart: (s) => (startPassage = s),
        setStoryData: (d) => (storyData = d),
        setSpecialBody: (name, body) => (specials[name] = body),
      });
      continue;
    }

    // Reject passage names that can't survive an emit-then-parse
    // round-trip. `[`/`]`/`|` corrupt the link brackets; `->` / `<-`
    // are the arrow-form delimiters and would re-parse at the arrow
    // (so `:: Chase->Escape` re-emits as `[[Chase->Escape]]` and
    // re-imports as text='Chase' + target='Escape'). Cheaper to
    // fail loudly at import than ship a story that silently breaks
    // its own export.
    if (
      raw.header.name.includes('[') ||
      raw.header.name.includes(']') ||
      raw.header.name.includes('|') ||
      raw.header.name.includes('->') ||
      raw.header.name.includes('<-')
    ) {
      throw new TweeParseError(
        `Passage name "${raw.header.name}" contains an unsupported character (\`[\`, \`]\`, \`|\`, \`->\`, or \`<-\`). Rename it before importing.`,
        'unsafe_passage_name',
      );
    }

    const id = passageNameToId(raw.header.name);
    if (Object.hasOwn(nodes, id)) {
      throw new TweeParseError(
        `Duplicate passage "${raw.header.name}" — Twee 3 passage names must be unique.`,
        'duplicate_passage',
      );
    }

    const { choices, contentBody } = extractLinks(raw.body);

    const node: StoryNode = {
      id,
      type: 'knot' as NodeType,
      parent: null,
      content: bodyToContent(contentBody),
      choices,
      divert: null,
      tags: raw.header.tags,
      lineNumber: raw.header.lineNumber,
      ...(raw.header.metadata ? { metadata: raw.header.metadata } : {}),
    };
    nodes[id] = node;

    // First non-special passage acts as the fallback start if
    // StoryData / Start don't provide one.
    if (!fallbackStart) fallbackStart = id;
    // Twine convention: a passage literally named "Start" acts as
    // the entry point when StoryData is absent.
    if (raw.header.name === 'Start') fallbackStart = id;
  }

  const resolvedStart = startPassage ?? fallbackStart ?? '';
  if (!resolvedStart) {
    errors.push({
      type: 'missing_start',
      message: 'No entry passage found. Add a passage named "Start" or a StoryData block.',
    });
  } else if (!Object.hasOwn(nodes, resolvedStart)) {
    errors.push({
      type: 'missing_start',
      message: `Start passage "${resolvedStart}" declared in StoryData but no matching passage found.`,
      nodeId: resolvedStart,
      args: { startName: resolvedStart },
    });
  }

  // Post-pass: unreachable + missing-target validation.
  validateReferences(nodes, resolvedStart, errors, warnings);

  const validation: ValidationResult = {
    valid: errors.length === 0,
    errors,
    warnings,
  };

  return {
    id: options.storyId ?? randomUUID(),
    title: title || 'Untitled',
    nodes,
    startNode: resolvedStart,
    validation,
    source,
    twee:
      storyData || Object.keys(specials).length > 0
        ? { storyData, specials: Object.keys(specials).length > 0 ? { ...specials } : undefined }
        : undefined,
  };
}

/**
 * StoryTitle → graph title. StoryData → JSON preserved verbatim on
 * graph.twee.storyData (plus its `start` field seeds startPassage).
 * StoryInit / PassageHeader / PassageFooter / StoryCaption / etc.
 * are stored raw on graph.twee.specials so the emitter round-trips
 * them; they aren't spliced into graph.nodes because they're global
 * wrappers, not story nodes.
 */
function handleSpecialPassage(
  raw: RawPassage,
  hooks: {
    setTitle: (t: string) => void;
    setStart: (s: string) => void;
    setStoryData: (d: Record<string, unknown>) => void;
    setSpecialBody: (name: string, body: string) => void;
  },
): void {
  const name = raw.header.name;
  if (name === 'StoryTitle') {
    hooks.setTitle(raw.body.trim() || 'Untitled');
    return;
  }
  if (name === 'StoryData') {
    // Body should be a JSON object; retain every field for round-trip,
    // and separately seed startPassage from `start`.
    try {
      const parsed = JSON.parse(raw.body.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        hooks.setStoryData(parsed as Record<string, unknown>);
        const start = (parsed as Record<string, unknown>).start;
        if (typeof start === 'string' && start.trim()) hooks.setStart(start.trim());
      }
    } catch (err) {
      // Non-fatal — the fallback start still works.
      void err;
    }
    return;
  }
  // Store the raw body verbatim for the emitter to reproduce. These
  // passages carry SugarCube macros / Harlowe hooks / static content
  // we don't understand at graph level.
  const body = raw.body.replace(/\n+$/, '');
  hooks.setSpecialBody(name, body);
}

function validateReferences(
  nodes: Record<string, StoryNode>,
  start: string,
  errors: ValidationMessage[],
  warnings: ValidationMessage[],
): void {
  const nodeIds = new Set(Object.keys(nodes));
  const reached = new Set<string>();
  const startResolvable = !!start && nodeIds.has(start);

  // check every passage's links/diverts up front, even if
  // it's unreachable from the start. Previously the missing_target
  // check ran inside the BFS, so a broken link inside an orphan
  // wouldn't surface until the author later wired the orphan into
  // the main flow — appearing as a "surprise" regression they
  // didn't cause. Do this pass unconditionally so authors see the
  // full set of errors on import.
  for (const id of nodeIds) {
    const node = nodes[id];
    for (const choice of node.choices) {
      if (!nodeIds.has(choice.target)) {
        errors.push({
          type: 'missing_target',
          message: `Link "${choice.text}" in passage "${id}" points at unknown passage "${choice.target}".`,
          nodeId: id,
          args: { sourceNode: id, linkText: choice.text, targetName: choice.target },
        });
      }
    }
    if (node.divert && !nodeIds.has(node.divert)) {
      errors.push({
        type: 'missing_target',
        message: `Divert in passage "${id}" points at unknown passage "${node.divert}".`,
        nodeId: id,
        args: { sourceNode: id, targetName: node.divert },
      });
    }
  }

  // BFS reachability from the start passage. Index pointer instead of
  // `queue.shift()` — Array#shift reindexes the whole array (O(n)),
  // which turns the traversal quadratic on stories with a few hundred
  // passages.
  if (startResolvable) {
    const queue: string[] = [start];
    let head = 0;
    while (head < queue.length) {
      const id = queue[head++];
      if (reached.has(id)) continue;
      reached.add(id);
      const node = nodes[id];
      for (const choice of node.choices) {
        if (nodeIds.has(choice.target) && !reached.has(choice.target)) {
          queue.push(choice.target);
        }
      }
      if (node.divert && nodeIds.has(node.divert) && !reached.has(node.divert)) {
        queue.push(node.divert);
      }
    }
  }

  // Suppress unreachable warnings when we had no valid start to walk
  // from — otherwise every passage would fire an unreachable_node
  // warning, drowning out the actual "no start" or "start points at a
  // missing passage" error the user needs to fix first.
  if (!startResolvable) return;

  for (const id of nodeIds) {
    if (!reached.has(id)) {
      warnings.push({
        type: 'unreachable_node',
        message: `Passage "${id}" is not reachable from the start passage.`,
        nodeId: id,
        args: { nodeName: id },
      });
    }
  }
}
