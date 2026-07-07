// Smallest-diff representation between two strings, returned as a
// single replace span: "delete this many characters at this offset,
// then insert this string". Used by the frontend's Yjs text-field
// binding to translate a controlled <input>'s new full value into
// the minimal sequence of Y.Text ops — important because Y.Text
// merges concurrent inserts at *their* offsets, and naïvely
// clearing + re-inserting the whole string would clobber remote
// edits that happened during the round trip.

export interface StringDiff {
  /** Offset in `before` where the change starts. */
  at: number;
  /** Number of characters to delete starting at `at`. */
  deleteLen: number;
  /** Text to insert at `at` after the delete. */
  insert: string;
}

/**
 * Compute the smallest single-span replace that turns `before` into
 * `after` by trimming the common prefix + common suffix.
 *
 * This isn't an optimal diff (Myers / patience would do better for
 * multi-block changes), but for the per-keystroke use case the
 * input string differs from the previous one by exactly one
 * contiguous span — which this picks up exactly.
 */
export function computeStringDiff(before: string, after: string): StringDiff {
  if (before === after) return { at: 0, deleteLen: 0, insert: '' };

  let commonPrefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (commonPrefix < maxPrefix && before[commonPrefix] === after[commonPrefix]) {
    commonPrefix++;
  }
  let commonSuffix = 0;
  while (
    commonSuffix < before.length - commonPrefix &&
    commonSuffix < after.length - commonPrefix &&
    before[before.length - 1 - commonSuffix] === after[after.length - 1 - commonSuffix]
  ) {
    commonSuffix++;
  }
  return {
    at: commonPrefix,
    deleteLen: before.length - commonPrefix - commonSuffix,
    insert: after.slice(commonPrefix, after.length - commonSuffix),
  };
}
