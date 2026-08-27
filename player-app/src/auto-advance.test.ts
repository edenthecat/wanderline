import { describe, expect, it } from 'vitest';
import { shouldAutoAdvance } from './App';

// Passages used to advance on their own unless a node explicitly said
// not to — and a node with no metadata row, the common case, said
// nothing. Combined with the database column defaulting to true, that
// meant effectively every passage advanced whether or not anyone chose
// it, which reads to a listener as the story moving by itself.
describe('shouldAutoAdvance', () => {
  it('is off when neither the node nor the project says anything', () => {
    expect(shouldAutoAdvance(undefined, undefined)).toBe(false);
    expect(shouldAutoAdvance({}, {})).toBe(false);
  });

  it('follows the project setting when the node has no opinion', () => {
    expect(shouldAutoAdvance(undefined, { autoAdvance: true })).toBe(true);
    expect(shouldAutoAdvance({}, { autoAdvance: false })).toBe(false);
  });

  // A passage the author deliberately configured wins over the project
  // default, in both directions.
  it('lets a node override the project setting', () => {
    expect(shouldAutoAdvance({ autoAdvance: false }, { autoAdvance: true })).toBe(false);
    expect(shouldAutoAdvance({ autoAdvance: true }, { autoAdvance: false })).toBe(true);
  });

  it('treats a missing project setting as off, not as unset-means-on', () => {
    expect(shouldAutoAdvance({}, { captionsDefault: true } as { autoAdvance?: boolean })).toBe(
      false,
    );
  });
});
