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
export type SearchableNode = Pick<StoryNode, 'id' | 'content'>;

/**
 * Trimmed + lowercased query. An empty result means "no query" —
 * call sites decide whether that means "show everything" (a filter)
 * or "no search is active" (GraphTab's match highlight).
 */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/** A node's content lines joined into one string, in reading order. */
export function nodeContentText(node: SearchableNode): string {
  return node.content?.map((c) => c.text).join(' ') ?? '';
}

/**
 * Does this node match an already-normalized query? An empty query
 * matches everything, which keeps `filter` call sites branch-free.
 */
export function nodeMatchesQuery(node: SearchableNode, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  if (node.id.toLowerCase().includes(normalizedQuery)) return true;
  return nodeContentText(node).toLowerCase().includes(normalizedQuery);
}

/**
 * Rank buckets for a match, lowest first: an id that starts with the
 * query beats an id that merely contains it, which beats a
 * content-only hit. Used by the command palette so typing an exact
 * passage name puts it on top; the tabs' own search boxes keep their
 * document order.
 */
export function matchRank(node: SearchableNode, normalizedQuery: string): number {
  if (!normalizedQuery) return 1;
  const id = node.id.toLowerCase();
  if (id === normalizedQuery) return 0;
  if (id.startsWith(normalizedQuery)) return 1;
  if (id.includes(normalizedQuery)) return 2;
  return 3;
}

/** First ~N characters of a node's content, for a one-line preview. */
export function nodeExcerpt(node: SearchableNode, maxLength = 120): string {
  const text = nodeContentText(node).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}
