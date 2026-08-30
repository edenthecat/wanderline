// One definition of "does this passage match what the author typed".
//
// StoryTab's filter bar and GraphTab's toolbar search each carried
// their own copy of this rule, and the copies disagreed on exactly
// one point:
//
//   StoryTab:  n.content.some((c) => c.text.toLowerCase().includes(q))
//   GraphTab:  node.content?.map((c) => c.text).join(' ').includes(q)
//
// A query that spans a content-line break ("she left the room" where
// the parser split after "left") matched in the Graph tab and not in
// the Story tab. We keep the joined form: content lines are how the
// parser chunked the file, not a boundary the author is thinking in
// when they type a phrase. That makes the rule strictly more
// permissive than StoryTab's old one, so nothing that used to appear
// in the Story list disappears from it.
//
// Everything else about the two was already identical: case-
// insensitive substring on the node id OR on its content, with the
// query trimmed.

import type { StoryNode } from '../api/client';

/** The subset of a node this module needs. Keeps the helpers usable
 * from tests and from anything holding a partial node. */
export type SearchableNode = Pick<StoryNode, 'content'>;

/**
 * Trimmed + lowercased query. An empty result means "no query" —
 * call sites decide whether that means "show everything" (a filter)
 * or "no search is active" (GraphTab's match highlight).
 */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/** A node's content lines joined into one string, in reading order. */
export function nodeContentText(node: SearchableNode | null | undefined): string {
  return node?.content?.map((c) => c.text).join(' ') ?? '';
}

/**
 * Does this node match an already-normalized query? An empty query
 * matches everything, which keeps `filter` call sites branch-free.
 *
 * `id` is passed separately rather than read off the node on purpose.
 * A stored graph's `nodes` record key and its node's own `id` field
 * are not guaranteed to agree on legacy rows, and callers key their
 * lookups off different ones — GraphTab and the palette off the record
 * key, StoryTab off `node.id`. Making that choice explicit at every
 * call site is the point.
 */
export function nodeMatchesQuery(
  id: string,
  node: SearchableNode | null | undefined,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  if (id.toLowerCase().includes(normalizedQuery)) return true;
  if (!node) return false;
  return nodeContentText(node).toLowerCase().includes(normalizedQuery);
}

/**
 * Rank buckets for a match, lowest first: an id that starts with the
 * query beats an id that merely contains it, which beats a
 * content-only hit. Used by the command palette so typing an exact
 * passage name puts it on top; the tabs' own search boxes keep their
 * document order.
 */
export function matchRank(id: string, normalizedQuery: string): number {
  if (!normalizedQuery) return 1;
  const lower = id.toLowerCase();
  if (lower === normalizedQuery) return 0;
  if (lower.startsWith(normalizedQuery)) return 1;
  if (lower.includes(normalizedQuery)) return 2;
  return 3;
}

/**
 * First ~N characters of a node's content, for a one-line preview.
 * Stops reading content lines as soon as it has enough of them — the
 * palette asks for this once per matching passage on every keystroke,
 * and a long knot's later lines can never reach the excerpt.
 */
export function nodeExcerpt(node: SearchableNode | null | undefined, maxLength = 120): string {
  let text = '';
  for (const line of node?.content ?? []) {
    text = text ? `${text} ${line.text}` : line.text;
    // Strictly past, not at: stopping exactly ON the limit would
    // return a truncated excerpt with no ellipsis on it.
    if (collapse(text).length > maxLength) break;
  }
  const collapsed = collapse(text);
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength).trimEnd()}…`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
