import { describe, expect, it } from 'vitest';
import {
  matchRank,
  nodeContentText,
  nodeExcerpt,
  nodeMatchesQuery,
  normalizeQuery,
  type SearchableNode,
} from '../nodeSearch';

const node = (id: string, ...lines: string[]): SearchableNode => ({
  id,
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
    expect(nodeMatchesQuery(node('the_harbour'), 'harb')).toBe(true);
  });

  it('matches on content', () => {
    expect(nodeMatchesQuery(node('n1', 'The gulls were screaming.'), 'gulls')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(nodeMatchesQuery(node('n1', 'The gulls were screaming.'), 'harbour')).toBe(false);
  });

  it('matches a phrase that spans two content lines', () => {
    // This is where the two old copies disagreed. StoryTab tested each
    // line separately and missed this; GraphTab joined them and found
    // it. The joined behaviour is what we standardised on.
    expect(nodeMatchesQuery(node('n1', 'She left', 'the room'), 'left the room')).toBe(true);
  });

  it('treats an empty query as matching everything', () => {
    expect(nodeMatchesQuery(node('n1'), '')).toBe(true);
  });

  it('survives a node with no content lines', () => {
    expect(nodeMatchesQuery({ id: 'n1' } as SearchableNode, 'anything')).toBe(false);
  });
});

describe('matchRank', () => {
  it('orders exact id, id prefix, id substring, then content-only', () => {
    expect(matchRank(node('harbour'), 'harbour')).toBe(0);
    expect(matchRank(node('harbour_night'), 'harbour')).toBe(1);
    expect(matchRank(node('the_harbour'), 'harbour')).toBe(2);
    expect(matchRank(node('docks', 'down at the harbour'), 'harbour')).toBe(3);
  });

  it('ranks everything alike when there is no query', () => {
    expect(matchRank(node('a'), '')).toBe(matchRank(node('b'), ''));
  });
});

describe('nodeExcerpt', () => {
  it('joins lines and collapses whitespace', () => {
    expect(nodeExcerpt(node('n1', 'One  line.', '\nAnother.'))).toBe('One line. Another.');
  });

  it('truncates with an ellipsis', () => {
    expect(nodeExcerpt(node('n1', 'abcdefghij'), 4)).toBe('abcd…');
  });

  it('is empty for a node with no content', () => {
    expect(nodeExcerpt(node('n1'))).toBe('');
  });
});

describe('nodeContentText', () => {
  it('joins lines with a single space in reading order', () => {
    expect(nodeContentText(node('n1', 'a', 'b'))).toBe('a b');
  });
});
