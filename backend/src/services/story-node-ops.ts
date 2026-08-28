/**
 * Graph surgery behind create-passage and delete-passage.
 *
 * These live outside the route so the hard parts — which references
 * point at a passage, which passages disappear with it, where a new
 * one sits in the fall-through order — are pure functions that can be
 * tested without a Postgres mock. The route keeps the transaction and
 * the side-table cascade.
 *
 * Every function takes an explicit `sourceLanguage`. Ink and Twee
 * disagree about what a name means: Ink scopes a bare `-> b` inside a
 * knot to that knot's stitch `<knot>.b` and treats `a.b` as a
 * knot/stitch path, while a Twee passage name means exactly itself and
 * may legally contain dots. Applying Ink's rules to a Twee graph
 * repoints links that were never ambiguous, so nothing here guesses.
 */

/** Ink's two built-in terminal targets. Never graph nodes. */
export const TERMINAL_TARGETS = new Set(['END', 'DONE']);

/**
 * `node_id` is `VARCHAR(255)` in every side table
 * (node_audio_assignments, node_metadata, node_flags,
 * audio_assignment_audit_acks). A longer id would live happily in the
 * JSONB graph and then fail the first time the author saved a
 * transcript against it, so it is rejected at creation instead.
 */
export const MAX_NODE_ID_LENGTH = 255;

export type SourceLanguage = 'ink' | 'twee';

/**
 * Structural view of a persisted node. Everything is optional: the
 * graph arrives from JSONB and older rows predate several fields.
 */
export interface GraphNodeShape {
  id?: string;
  type?: string;
  parent?: string | null;
  content?: { text: string; tags: string[] }[];
  choices?: { text?: string; target?: string }[];
  divert?: string | null;
  tags?: string[];
  lineNumber?: number;
}

export type GraphNodes = Record<string, GraphNodeShape>;

/**
 * Resolve a stored `choice.target` / `node.divert` to the graph key it
 * actually names, or null when it names nothing in the graph (a
 * terminal target, or a dangling reference we leave alone).
 *
 * Resolution order is EXACT MATCH FIRST, then the referring knot's
 * stitch — deliberately the same precedence `resolveBareStitchTargets`
 * in ink-parser.ts documents. Strict Ink prefers the local stitch, but
 * matching the parser matters more here: this decides which passages
 * count as referring to the one being deleted, and disagreeing with
 * the parser would either block a delete that breaks nothing or let
 * one through that dangles.
 */
export function resolveTargetId(
  target: string | null | undefined,
  fromNodeId: string,
  nodes: GraphNodes,
  sourceLanguage: SourceLanguage,
): string | null {
  if (typeof target !== 'string' || target === '') return null;
  if (TERMINAL_TARGETS.has(target)) return null;
  // Own-property checks throughout: `constructor` / `toString` are
  // legal Ink names under the parser's `\w+` rule and a plain object
  // answers truthily for all of them.
  if (Object.hasOwn(nodes, target)) return target;
  if (sourceLanguage === 'ink' && !target.includes('.')) {
    const knot = fromNodeId.split('.')[0];
    const qualified = `${knot}.${target}`;
    if (Object.hasOwn(nodes, qualified)) return qualified;
  }
  return null;
}

/**
 * Every node id that disappears when `nodeId` is deleted.
 *
 * In Ink a stitch cannot outlive its knot — the parser reports a
 * parentless stitch as `orphaned_stitch` and the emitter has nowhere
 * to write it — so deleting a knot takes its stitches with it. Twee
 * has no hierarchy: exactly one passage goes.
 *
 * Membership is checked by BOTH `parent` and the `<knot>.` key prefix.
 * They agree in a parser-produced graph, but a hand-edited or
 * partially-migrated row can carry one without the other, and leaving
 * either behind orphans a stitch under a knot that no longer exists.
 */
export function collectDeletionSet(
  nodeId: string,
  nodes: GraphNodes,
  sourceLanguage: SourceLanguage,
): string[] {
  const deleted = [nodeId];
  if (sourceLanguage !== 'ink') return deleted;
  const node = nodes[nodeId];
  // Only a knot owns children. A stitch id contains a dot; a knot's
  // does not, which is also the fallback when `type` is missing.
  const isKnot = node?.type ? node.type === 'knot' : !nodeId.includes('.');
  if (!isKnot) return deleted;
  const prefix = `${nodeId}.`;
  for (const key of Object.keys(nodes)) {
    if (key === nodeId) continue;
    if (nodes[key]?.parent === nodeId || key.startsWith(prefix)) deleted.push(key);
  }
  return deleted;
}

export interface InboundReference {
  /** Node holding the reference. Never a member of the delete set. */
  from: string;
  via: 'choice' | 'divert';
  /** Index into `from`'s choices array. Undefined for a divert. */
  choiceIndex?: number;
  /** The reference exactly as stored — may be a bare stitch name. */
  target: string;
  /** Graph key `target` resolves to; always inside the delete set. */
  resolved: string;
}

/**
 * Every reference from OUTSIDE `deleteSet` that lands INSIDE it.
 *
 * References between two doomed nodes are ignored — both sides go, so
 * nothing dangles. The result is what makes a delete unsafe, and (when
 * the caller supplies a replacement) exactly the list to rewrite.
 */
export function findInboundReferences(
  deleteSet: ReadonlySet<string>,
  nodes: GraphNodes,
  sourceLanguage: SourceLanguage,
): InboundReference[] {
  const found: InboundReference[] = [];
  for (const fromId of Object.keys(nodes)) {
    if (deleteSet.has(fromId)) continue;
    const node = nodes[fromId];
    const choices = Array.isArray(node?.choices) ? node.choices : [];
    for (let i = 0; i < choices.length; i++) {
      const target = choices[i]?.target;
      const resolved = resolveTargetId(target, fromId, nodes, sourceLanguage);
      if (resolved && deleteSet.has(resolved)) {
        found.push({
          from: fromId,
          via: 'choice',
          choiceIndex: i,
          target: target as string,
          resolved,
        });
      }
    }
    const divert = node?.divert;
    const resolvedDivert = resolveTargetId(divert, fromId, nodes, sourceLanguage);
    if (resolvedDivert && deleteSet.has(resolvedDivert)) {
      found.push({
        from: fromId,
        via: 'divert',
        target: divert as string,
        resolved: resolvedDivert,
      });
    }
  }
  return found;
}

/**
 * Point every listed reference at `replacement`, in place.
 *
 * `replacement` is always a full graph key (or END/DONE), never a bare
 * stitch name, so the rewritten reference resolves the same way from
 * any knot — including one that happens to own a stitch of the same
 * name.
 */
export function repointReferences(
  references: readonly InboundReference[],
  replacement: string,
  nodes: GraphNodes,
): void {
  for (const ref of references) {
    const node = nodes[ref.from];
    if (!node) continue;
    if (ref.via === 'choice') {
      const choice = node.choices?.[ref.choiceIndex as number];
      if (choice) choice.target = replacement;
    } else {
      node.divert = replacement;
    }
  }
}

/** The validation block as it sits on a persisted graph. */
export interface GraphValidation {
  valid?: boolean;
  errors?: { type?: string; nodeId?: string }[];
  warnings?: { type?: string; nodeId?: string }[];
}

/**
 * Drop validation messages a graph edit has provably invalidated.
 *
 * Neither endpoint re-runs the validator — that means re-parsing, and
 * these are surgical single-node edits. But leaving the stored block
 * untouched is worse than leaving it stale: the editor renders
 * `validation.errors` verbatim, so an author who creates the story's
 * first passage keeps being told "No start node found", and one who
 * deletes a passage keeps seeing errors about a node that is gone.
 *
 * Only removal, never addition: `keep` decides what is still true, and
 * anything this can't reason about stays. Under-reporting is the safe
 * direction — the client-side story health panel recomputes
 * reachability from the graph itself.
 */
export function pruneValidation(
  validation: GraphValidation | null | undefined,
  keep: (message: { type?: string; nodeId?: string }) => boolean,
): void {
  if (!validation) return;
  if (Array.isArray(validation.errors)) validation.errors = validation.errors.filter(keep);
  if (Array.isArray(validation.warnings)) validation.warnings = validation.warnings.filter(keep);
  // `valid` is defined as "no errors", so it has to move with them.
  if (Array.isArray(validation.errors)) validation.valid = validation.errors.length === 0;
}

export interface NewNodeId {
  nodeId: string;
  type: 'knot' | 'stitch';
  /** Owning knot for an Ink stitch; null for a knot or a Twee passage. */
  parent: string | null;
}

/**
 * Ink names the parser can read back verbatim.
 *
 * The parser itself accepts `\w+`, which allows a leading digit, but
 * the emitter prefixes such a name with `_` to keep the generated
 * `.ink` legal — so `1a` would come back from a round-trip as a
 * DIFFERENT node. Creation is the one moment we can rule that out
 * without breaking graphs that already exist, so it is ruled out.
 */
const INK_NAME_RE = /^[A-Za-z_]\w*$/;

/**
 * Twee names that are metadata rather than story passages. Kept in
 * sync with the parser's own SPECIAL_PASSAGES — a passage created
 * under one of these names would be swallowed as metadata the next
 * time the exported source was re-imported.
 */
export const TWEE_RESERVED_NAMES = new Set([
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
 * Characters a Twee passage name cannot survive.
 *
 * `[`, `]`, `|`, `->` and `<-` are the LINK delimiters — a name
 * carrying one of them corrupts `[[Text|Target]]` on emit, which is
 * why the parser rejects them at import too.
 *
 * `{` and `}` are the HEADER metadata delimiters, and they are worse:
 * `emitTwee` writes `:: Cave {2}`, and `parsePassageHeader` truncates
 * `rest` at the trailing brace group WHETHER OR NOT the JSON parses
 * (twee-parser.ts — the `JSON.parse` failure is swallowed and the
 * slice happens anyway). So `Cave {2}` comes back from a round-trip
 * as `Cave`, taking every link to it with it. Nothing warns.
 *
 * Exported so the rename endpoint applies the same rule — two copies
 * of this list would drift, and a name rejected at creation must not
 * be reachable by renaming into it.
 */
export const TWEE_UNSAFE_NAME_RE = /[[\]|{}]|->|<-/;

/** Human-readable form of TWEE_UNSAFE_NAME_RE, for error messages. */
export const TWEE_UNSAFE_NAME_DESCRIPTION = '`[`, `]`, `|`, `{`, `}`, `->`, or `<-`';

/** Control characters: legal in JSONB, corrupting in both emitters. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Rules a node id must satisfy to be STORABLE, whatever put it there.
 * Shared by create-passage and rename so a name one refuses cannot be
 * reached through the other. Returns an error message, or null when
 * the id is fine.
 *
 * `label` names the request field so the message reads correctly on
 * both endpoints ("nodeId" / "newId").
 *
 * Deliberately NOT included: the Ink identifier rule. Graphs already
 * hold names the Ink parser would never produce (a Twee import, a
 * hand-edited row), and refusing to rename those would trap whoever
 * owns them. Creation is the one moment a stricter rule costs nothing,
 * so `parseNewNodeId` adds it on top of this.
 */
export function storableNodeIdError(
  nodeId: string,
  sourceLanguage: SourceLanguage,
  label = 'nodeId',
): string | null {
  if (!nodeId) return `${label} must be a non-empty string`;
  if (nodeId.length > MAX_NODE_ID_LENGTH) {
    return `${label} must be ${MAX_NODE_ID_LENGTH} characters or fewer`;
  }
  if (CONTROL_CHAR_RE.test(nodeId)) {
    return `${label} must not contain control characters`;
  }
  if (TERMINAL_TARGETS.has(nodeId)) {
    return `"${nodeId}" is a reserved target name and cannot be used as a node id`;
  }
  // `__proto__` is a legal Ink name under `\w+` and a legal Twee
  // title, but it is not a storable key: the graph arrives from JSONB
  // via JSON.parse, so it carries Object.prototype, and assigning
  // `nodes['__proto__']` runs the prototype SETTER instead of creating
  // an own property. The node would be reported as written, appear in
  // no listing, and defeat every `Object.hasOwn` check afterwards —
  // with the graph's own prototype swapped for it. `defineNode` makes
  // the write itself safe; refusing the name keeps a passage that can
  // never be exported out of the graph in the first place.
  if (nodeId === '__proto__') {
    return '"__proto__" cannot be used as a node id';
  }
  if (sourceLanguage === 'twee') {
    if (TWEE_UNSAFE_NAME_RE.test(nodeId)) {
      return `${label} contains a character that is unsafe for Twee (${TWEE_UNSAFE_NAME_DESCRIPTION}). Choose a different name.`;
    }
    if (TWEE_RESERVED_NAMES.has(nodeId)) {
      // The parser reads these as metadata rather than passages, so
      // exporting one emits a second `:: StoryData` block and
      // re-importing swallows the passage and every link to it.
      return `"${nodeId}" is a reserved Twee passage name`;
    }
  }
  return null;
}

/**
 * Write `node` under `key`, creating an own property even for a key
 * Object.prototype defines an accessor for. See the `__proto__` note
 * on `storableNodeIdError`: a plain assignment there stores nothing
 * and swaps the map's prototype instead.
 */
export function defineNode(nodes: GraphNodes, key: string, node: GraphNodeShape): void {
  Object.defineProperty(nodes, key, {
    value: node,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Validate a requested id and work out what kind of node it describes.
 * Returns an error string instead of throwing so the route can map it
 * straight to a 400 body.
 */
export function parseNewNodeId(
  rawId: string,
  sourceLanguage: SourceLanguage,
): { error: string } | NewNodeId {
  const nodeId = rawId.trim();
  const storableError = storableNodeIdError(nodeId, sourceLanguage);
  if (storableError) return { error: storableError };

  if (sourceLanguage === 'twee') {
    // Twee has no hierarchy — every passage is top-level, and a dot is
    // an ordinary character in a title.
    return { nodeId, type: 'knot', parent: null };
  }

  const segments = nodeId.split('.');
  if (segments.length > 2) {
    return {
      error: 'nodeId may name a knot ("chapter") or a stitch ("chapter.scene"), but no deeper',
    };
  }
  for (const segment of segments) {
    if (!INK_NAME_RE.test(segment)) {
      return {
        error:
          'Ink names must start with a letter or underscore and contain only letters, digits and underscores',
      };
    }
  }
  return segments.length === 2
    ? { nodeId, type: 'stitch', parent: segments[0] }
    : { nodeId, type: 'knot', parent: null };
}

/**
 * The nodes that move as one unit with `nodeId` — itself plus, for an
 * Ink knot, its stitches. Insertion happens after the whole unit so a
 * new knot lands after the previous knot's stitches rather than
 * between the knot header and its own first stitch.
 */
function unitMembers(
  nodeId: string,
  nodes: GraphNodes,
  sourceLanguage: SourceLanguage,
): Set<string> {
  return new Set(collectDeletionSet(nodeId, nodes, sourceLanguage));
}

/**
 * Insert `newId` into the graph's ordering and renumber `lineNumber`
 * across every node so the sequence is 1..n with no ties.
 *
 * Why renumber rather than "+1 and shift everything after":
 * `lineNumber` is the only thing that orders siblings, and Ink's
 * implicit fall-through reads that order — a stitch that ends without
 * a divert continues into the NEXT sibling (see
 * player-app/src/fall-through.ts). Compiled-Ink-JSON uploads set every
 * node's lineNumber to 0, so "after X" has no arithmetic answer in
 * those graphs at all. Sorting by lineNumber reproduces exactly the
 * order every consumer already sees today — the sort is stable, so
 * ties keep insertion order, which is the same tie-break those
 * consumers already fall back on — so renumbering changes no existing
 * ordering; it just makes the order explicit enough to insert into.
 *
 * The original source line numbers are lost, which costs nothing: any
 * graph edit already nulls `ink_source`, so the numbers no longer
 * refer to text anyone has. In an all-zero graph the order this bakes
 * in is the graph's own key order — which is what every consumer was
 * already reading via the stable sort, so the story does not change;
 * what changes is that the Ink export now agrees with the player
 * instead of alphabetising.
 *
 * `afterId` places the node directly after that unit, EXCEPT when it
 * names the new stitch's own knot: that means "first stitch", i.e.
 * immediately after the knot header and before its existing stitches.
 * A knot runs by its lowest-lineNumber stitch, so that slot is how a
 * chapter gets a new opening scene, and "after the whole knot unit"
 * would put it last instead. Without `afterId` the node appends — to
 * the end of its parent knot's stitches for a stitch, or to the end of
 * the graph for a knot / Twee passage.
 */
export function insertNodeOrdered(
  nodes: GraphNodes,
  newId: string,
  newNode: GraphNodeShape,
  options: {
    afterId?: string | null;
    parent?: string | null;
    sourceLanguage: SourceLanguage;
  },
): void {
  const { afterId, parent, sourceLanguage } = options;
  const order = Object.keys(nodes).sort(
    (a, b) => (nodes[a]?.lineNumber ?? 0) - (nodes[b]?.lineNumber ?? 0),
  );

  // Index just past the last member of the unit we're inserting after.
  // An anchor that isn't in the graph falls back to appending — the
  // route validates it first, so this only guards against a future
  // caller that doesn't, where landing at the FRONT of the story
  // would silently rewrite which passage plays first.
  const endOfUnit = (anchorId: string): number => {
    const members = unitMembers(anchorId, nodes, sourceLanguage);
    let last = -1;
    for (let i = 0; i < order.length; i++) {
      if (members.has(order[i])) last = i;
    }
    return last === -1 ? order.length : last + 1;
  };

  let position: number;
  if (afterId && parent && afterId === parent) {
    // "First stitch": directly after the knot header, ahead of the
    // stitches it already owns.
    const knotIndex = order.indexOf(parent);
    position = knotIndex === -1 ? order.length : knotIndex + 1;
  } else if (afterId) {
    position = endOfUnit(afterId);
  } else if (parent) {
    // Append to the end of the parent knot's stitches.
    position = endOfUnit(parent);
  } else {
    position = order.length;
  }

  order.splice(position, 0, newId);
  defineNode(nodes, newId, newNode);
  for (let i = 0; i < order.length; i++) {
    const node = nodes[order[i]];
    if (node) node.lineNumber = i + 1;
  }
}
