import { describe, expect, it } from 'vitest';
import { INK_VOCAB, TWEE_VOCAB, resolveVocab } from '../nomenclature';

// vocab resolution — source_language decides the default,
// user preference overrides. The 'auto' preference falls through.

describe('resolveVocab', () => {
  it('returns INK_VOCAB for source_language=ink + auto preference', () => {
    expect(resolveVocab('ink', 'auto')).toBe(INK_VOCAB);
  });

  it('returns TWEE_VOCAB for source_language=twee + auto preference', () => {
    expect(resolveVocab('twee', 'auto')).toBe(TWEE_VOCAB);
  });

  it('preference=ink overrides source_language=twee', () => {
    expect(resolveVocab('twee', 'ink')).toBe(INK_VOCAB);
  });

  it('preference=twee overrides source_language=ink', () => {
    expect(resolveVocab('ink', 'twee')).toBe(TWEE_VOCAB);
  });

  it('falls back to INK_VOCAB when source_language is missing', () => {
    // Pre-migration rows, or a project that hasn't had a story
    // uploaded yet, might not carry a source_language.
    expect(resolveVocab(null, 'auto')).toBe(INK_VOCAB);
    expect(resolveVocab(undefined, 'auto')).toBe(INK_VOCAB);
  });

  it('treats invalid preference values as auto', () => {
    // Defensive against a stray value coming out of project_settings
    // JSONB — a typo like 'twe' shouldn't crash the vocab lookup.
    expect(resolveVocab('twee', null)).toBe(TWEE_VOCAB);
    expect(resolveVocab('twee', undefined)).toBe(TWEE_VOCAB);
    expect(resolveVocab('ink', 'garbage' as unknown as 'auto')).toBe(INK_VOCAB);
  });
});

describe('vocab shape', () => {
  it('Ink has distinct node + subNode', () => {
    expect(INK_VOCAB.node.singular).toBe('knot');
    expect(INK_VOCAB.subNode.singular).toBe('stitch');
    expect(INK_VOCAB.choice.plural).toBe('choices');
  });

  it('Twee collapses subNode (empty strings) so callers can skip the "N stitches" stat entirely', () => {
    // The StoryTab uses `vocab.subNode.plural &&` as the gate for
    // rendering the sub-node stats block. If we ever set a non-empty
    // Twee sub-node label, that gate needs to relax.
    expect(TWEE_VOCAB.subNode.singular).toBe('');
    expect(TWEE_VOCAB.subNode.plural).toBe('');
  });

  it('Twee uses link + passage nomenclature', () => {
    expect(TWEE_VOCAB.node.singular).toBe('passage');
    expect(TWEE_VOCAB.choice.singular).toBe('link');
    expect(TWEE_VOCAB.divert).toBe('continue');
  });
});
