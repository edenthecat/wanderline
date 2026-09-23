import { describe, expect, it } from 'vitest';
import {
  matchRank,
  nodeContentText,
  nodeExcerpt,
  nodeMatchesQuery,
  normalizeQuery,
  type SearchableNode,
} from '../nodeSearch';

const node = (...lines: string[]): SearchableNode => ({
  content: lines.map((text) => ({ text, tags: [] })),
});

describe('normalizeQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeQuery('  Harbour ')).toBe('harbour');
  });

  it('collapses whitespace-only input to the empty query', () => {
    expect(normalizeQuery('   ')).toBe('');
  });
});

describe('nodeMatchesQuery', () => {
  it('matches on node id, case-insensitively', () => {
    expect(nodeMatchesQuery('the_harbour', node(), 'harb')).toBe(true);
  });

  it('matches on content', () => {
    expect(nodeMatchesQuery('n1', node('The gulls were screaming.'), 'gulls')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(nodeMatchesQuery('n1', node('The gulls were screaming.'), 'harbour')).toBe(false);
  });

  it('matches a phrase that spans two content lines', () => {
    // This is where the two old copies disagreed. StoryTab tested each
    // line separately and missed this; GraphTab joined them and found
    // it. The joined behaviour is what we standardised on.
    expect(nodeMatchesQuery('n1', node('She left', 'the room'), 'left the room')).toBe(true);
  });

  it('treats an empty query as matching everything', () => {
    expect(nodeMatchesQuery('n1', node(), '')).toBe(true);
  });

  it('survives a node with no content lines, and a missing node', () => {
    expect(nodeMatchesQuery('n1', {} as SearchableNode, 'anything')).toBe(false);
    expect(nodeMatchesQuery('n1', null, 'anything')).toBe(false);
  });

  it('matches on the id it is given, not one read off the node', () => {
    // The record key and node.id can disagree on a legacy stored
    // graph, and callers key their lookups off different ones.
    expect(nodeMatchesQuery('record_key', node('body'), 'record')).toBe(true);
  });
});

describe('matchRank', () => {
  it('orders exact id, id prefix, id substring, then content-only', () => {
    expect(matchRank('harbour', 'harbour')).toBe(0);
    expect(matchRank('harbour_night', 'harbour')).toBe(1);
    expect(matchRank('the_harbour', 'harbour')).toBe(2);
    expect(matchRank('docks', 'harbour')).toBe(3);
  });

  it('ranks everything alike when there is no query', () => {
    expect(matchRank('a', '')).toBe(matchRank('b', ''));
  });
});

describe('nodeExcerpt', () => {
  it('joins lines and collapses whitespace', () => {
    expect(nodeExcerpt(node('One  line.', '\nAnother.'))).toBe('One line. Another.');
  });

  it('truncates with an ellipsis', () => {
    expect(nodeExcerpt(node('abcdefghij'), 4)).toBe('abcd…');
  });

  it('marks a cut that lands exactly on the limit at a line boundary', () => {
    // The early-out has to look strictly PAST the limit, or a passage
    // whose first lines total exactly maxLength renders truncated
    // content with nothing saying so.
    expect(nodeExcerpt(node('abcd', 'efgh'), 4)).toBe('abcd…');
    // ...and a passage that genuinely ends there gets no ellipsis.
    expect(nodeExcerpt(node('abcd'), 4)).toBe('abcd');
  });

  it('is empty for a node with no content', () => {
    expect(nodeExcerpt(node())).toBe('');
    expect(nodeExcerpt(null)).toBe('');
  });
});

describe('nodeContentText', () => {
  it('joins lines with a single space in reading order', () => {
    expect(nodeContentText(node('a', 'b'))).toBe('a b');
  });
});
