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
 *   - Twine macro dialect detection (DEV-199 Phase 6): StoryData's
 *     `format` field, or — when that's missing/unrecognized — a
 *     syntax-sniffing heuristic over macro delimiters, resolves to
 *     'harlowe' | 'sugarcube' | 'chapbook' on graph.twee.dialect.
 *     Genuinely ambiguous input (no signal, or a tie between two
 *     dialects) surfaces an `ambiguous_twee_dialect` validation
 *     warning rather than guessing — misdetection would silently
 *     parse real macro variables/conditionals through the wrong
 *     grammar. See detectTweeDialect.
 *
 * <<macros>> and conditional links (`[[Text|Target][cond]]`) are
 * still parsed-but-inert as of Phase 6 — dialect detection on its own
 * doesn't yet translate macro syntax into Choice.condition /
 * AssignmentBlock content. That's Phases 7 (Harlowe), 8 (SugarCube),
 * and 9 (Chapbook), each building on the dialect this module now
 * resolves.
 *
 * Twee 1 rejection: the `.tw` extension is used for both Twee 1 and
 * Twee 3. Detection is a single signal — a source with NO `:: `
 * header and at least one `!Name` line at column 0. We throw a
 * TweeParseError with code `'twee1_detected'` and a message asking
 * the user to re-export from Twine 2 as Twee 3.
 */

import { randomUUID } from 'node:crypto';
import { evaluate } from '@wanderline/shared';
import type {
  StoryGraph,
  StoryNode,
  ContentBlock,
  Choice,
  ValidationResult,
  ValidationMessage,
  NodeType,
  TweeDialect,
} from '../types.js';
import { extractLinks, bodyToContent } from './twee-content.js';
import { processHarlowePassageBody, createHarloweVariableState } from './harlowe-macros.js';

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
 * Twee 3 identifiers can contain spaces, but StoryGraph node
 * ids are keyed under Record<string, StoryNode>. We use the passage
 * name verbatim as the id — same convention Ink uses for knot names —
 * so `[[go home]]` in Twee resolves to the passage `Home` (or `go home`
 * if that's the actual passage title). No normalisation.
 */
function passageNameToId(name: string): string {
  return name;
}

export interface ParseTweeOptions {
  /** Story ID to assign. Generated when omitted. */
  storyId?: string;
}

export interface DialectDetectionResult {
  dialect: TweeDialect | null;
  /** True when `dialect` (or the lack of one) came from sniffing
   * macro syntax rather than an explicit StoryData `format` field. */
  sniffed: boolean;
  /**
   * True when `dialect` is null AND there's an actual reason to flag
   * it — either the source has macro-like syntax that didn't resolve
   * to one dialect (a genuine tie), or StoryData explicitly named a
   * format this parser doesn't recognize. False for the overwhelming
   * common case — plain Twee with no format set and no macros
   * anywhere — where there's nothing to misdetect and a warning
   * would just be noise on every ordinary hyperlink-based story.
   */
  ambiguous: boolean;
}

const FORMAT_FIELD_DIALECT_PATTERNS: { pattern: RegExp; dialect: TweeDialect }[] = [
  { pattern: /harlowe/i, dialect: 'harlowe' },
  { pattern: /sugarcube/i, dialect: 'sugarcube' },
  { pattern: /chapbook/i, dialect: 'chapbook' },
];

function detectDialectFromFormatField(
  storyData: Record<string, unknown> | undefined,
): TweeDialect | null {
  const format = storyData?.format;
  if (typeof format !== 'string') return null;
  for (const { pattern, dialect } of FORMAT_FIELD_DIALECT_PATTERNS) {
    if (pattern.test(format)) return dialect;
  }
  return null;
}

// Syntax signatures used ONLY when StoryData's `format` field is
// missing or names something this parser doesn't recognize (a custom
// format, Snowman, a typo). Each dialect's macro delimiter is close
// to unambiguous on its own, EXCEPT Chapbook's vars-block separator —
// a bare `--` alone on its own line — which can also appear as prose
// (an em-dash substitute), so it counts for the same single point a
// real `[if ...]` match would rather than being weighted higher.
const HARLOWE_MACRO_RE = /\(\s*(set|if|display|print|link|goto)\s*:/gi;
const SUGARCUBE_MACRO_RE = /<<\s*(set|if|print|display|goto|link)\b/gi;
const CHAPBOOK_INSERT_RE = /^\[(if|else|unless)\b/gim;
const CHAPBOOK_VARS_SEPARATOR_RE = /^--\s*$/m;

function sniffDialectFromSource(source: string): { dialect: TweeDialect | null; anyHits: boolean } {
  const chapbookInsertHits = (source.match(CHAPBOOK_INSERT_RE) ?? []).length;
  const hits: Array<[TweeDialect, number]> = [
    ['harlowe', (source.match(HARLOWE_MACRO_RE) ?? []).length],
    ['sugarcube', (source.match(SUGARCUBE_MACRO_RE) ?? []).length],
    [
      'chapbook',
      // The vars-block separator only counts as a tie-breaking BONUS
      // on top of an already-real [if]/insert match — on its own a
      // bare `--` line is too easily confused with a prose em-dash
      // paragraph break, which would otherwise misdetect any plain
      // Harlowe/SugarCube story that happens to use one as Chapbook.
      chapbookInsertHits +
        (chapbookInsertHits > 0 && CHAPBOOK_VARS_SEPARATOR_RE.test(source) ? 1 : 0),
    ],
  ];
  const withHits = hits.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (withHits.length === 0) return { dialect: null, anyHits: false };
  // A tie between two dialects' signatures is exactly the
  // "misdetection would silently produce a wrong-but-plausible parse"
  // case the plan warns about — stay ambiguous rather than picking
  // arbitrarily between them.
  if (withHits.length > 1 && withHits[0][1] === withHits[1][1]) {
    return { dialect: null, anyHits: true };
  }
  return { dialect: withHits[0][0], anyHits: true };
}

/**
 * Resolve which Twine macro dialect a Twee source uses. Prefers
 * StoryData's own `format` field (what Twine itself wrote on export);
 * falls back to sniffing macro syntax only when that's missing or
 * names a format this parser doesn't recognize. Returns a null
 * dialect when genuinely ambiguous — callers must not guess, since a
 * wrong dialect silently parses real macro variables/conditionals
 * through the wrong grammar in Phases 7-9.
 *
 * `ambiguous` deliberately excludes the "no format, no macros
 * anywhere" case: an ordinary hyperlink-based Twee story has nothing
 * for any dialect to misdetect, so it stays silently undetected
 * rather than raising a warning with no actionable follow-up.
 */
export function detectTweeDialect(
  storyData: Record<string, unknown> | undefined,
  source: string,
): DialectDetectionResult {
  const fromFormat = detectDialectFromFormatField(storyData);
  if (fromFormat) return { dialect: fromFormat, sniffed: false, ambiguous: false };

  const sniffed = sniffDialectFromSource(source);
  const formatNamedSomethingUnrecognized =
    typeof storyData?.format === 'string' && storyData.format.trim().length > 0;
  return {
    dialect: sniffed.dialect,
    sniffed: true,
    ambiguous: sniffed.dialect === null && (sniffed.anyHits || formatNamedSomethingUnrecognized),
  };
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
/**
 * Find StoryData's `format` field (if any) WITHOUT running the full
 * special-passage handling pass — needed before the main loop below,
 * since every passage's body has to be processed with the right
 * dialect-specific (or generic) pipeline from its very first
 * iteration, not just once storyData happens to have been seen.
 * "Last StoryData wins" matches the main loop's own duplicate-header
 * handling.
 */
function findStoryDataForDialectDetection(
  rawPassages: RawPassage[],
): Record<string, unknown> | undefined {
  let result: Record<string, unknown> | undefined;
  for (const raw of rawPassages) {
    if (raw.header.name !== 'StoryData') continue;
    try {
      const parsed = JSON.parse(raw.body.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore — the main loop's handleSpecialPassage pass surfaces
      // (or silently tolerates) malformed StoryData as before; this
      // early pass only cares about `format`, when parseable at all.
    }
  }
  return result;
}

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

  // Twine macro dialect detection (DEV-199 Phase 6) — resolved before
  // the main loop, not after, because EVERY passage body below needs
  // to know which pipeline (generic, or a dialect module's own) to
  // run through from its first iteration.
  const dialectResult = detectTweeDialect(findStoryDataForDialectDetection(rawPassages), source);
  if (dialectResult.ambiguous) {
    warnings.push({
      type: 'ambiguous_twee_dialect',
      message:
        "Could not determine which Twine macro format (Harlowe, SugarCube, or Chapbook) this story uses. Macro-based variables and conditionals won't be understood until the format is set in Twine's Story Details, or the story is re-exported with a format-identifying StoryData block.",
    });
  }
  // DEV-199 Phase 7: implicit variable declarations threaded across
  // every passage, in file order, so the first (set:)/(put:) for a
  // given $-name anywhere in the story is the one that declares it.
  const harloweVariableState = createHarloweVariableState();

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

    let content: ContentBlock[];
    let choices: Choice[];
    if (dialectResult.dialect === 'harlowe') {
      const processed = processHarlowePassageBody(
        raw.body,
        harloweVariableState,
        evaluate,
        warnings,
        raw.header.lineNumber,
      );
      content = processed.content;
      choices = processed.choices;
    } else {
      const extracted = extractLinks(raw.body);
      choices = extracted.choices;
      content = bodyToContent(extracted.contentBody);
    }

    const node: StoryNode = {
      id,
      type: 'knot' as NodeType,
      parent: null,
      content,
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
    ...(harloweVariableState.variables.length > 0
      ? { variables: harloweVariableState.variables }
      : {}),
    twee:
      storyData || Object.keys(specials).length > 0 || dialectResult.dialect
        ? {
            storyData,
            specials: Object.keys(specials).length > 0 ? { ...specials } : undefined,
            dialect: dialectResult.dialect ?? undefined,
          }
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
